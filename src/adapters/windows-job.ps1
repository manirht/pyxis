# Start the native CLI suspended, attach it to a kernel job, then release it.
# Closing the supervisor kills the entire job even if a parent already exited.
$ErrorActionPreference = 'Stop'
try {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class RcaProcessJob {
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits {
        public BasicLimits Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public int X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public short Show, ReservedSize;
        public IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string file, StringBuilder args, IntPtr processAttributes,
        IntPtr threadAttributes, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int number);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
        out SafeFileHandle copy, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(SafeFileHandle thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(SafeFileHandle process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeFileHandle handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeFileHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(SafeFileHandle process, out long created, out long exited,
        out long kernelTime, out long userTime);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(SafeFileHandle process, out uint code);

    private static void Check(bool success) {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    private static SafeFileHandle Inherit(IntPtr self, int number) {
        SafeFileHandle copy;
        Check(DuplicateHandle(self, GetStdHandle(number), self, out copy, 0, true, 2));
        return copy;
    }

    public static int Run(string file, string arguments, uint parentPid) {
        using (var job = CreateJobObject(IntPtr.Zero, null))
        using (var supervisor = Process.GetCurrentProcess())
        using (var parent = OpenProcess(0x101000, false, parentPid)) // SYNCHRONIZE | QUERY_LIMITED_INFORMATION
        using (var input = Inherit(supervisor.Handle, -10))
        using (var output = Inherit(supervisor.Handle, -11))
        using (var error = Inherit(supervisor.Handle, -12)) {
            Check(!job.IsInvalid);
            if (parent.IsInvalid) return 125;
            long born, exited, kernelTime, userTime;
            Check(GetProcessTimes(parent, out born, out exited, out kernelTime, out userTime));
            // If the original runner has already died, its PID can be reused.
            if (born > supervisor.StartTime.ToUniversalTime().ToFileTimeUtc() || WaitForSingleObject(parent, 0) != 258)
                return 125;
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
            var startup = new StartupInfo();
            startup.Size = Marshal.SizeOf(typeof(StartupInfo));
            startup.Flags = 0x100; // STARTF_USESTDHANDLES
            startup.Input = input.DangerousGetHandle();
            startup.Output = output.DangerousGetHandle();
            startup.Error = error.DangerousGetHandle();
            var commandLine = new StringBuilder("\"" + file + "\" " + arguments);
            ProcessInfo info;
            // CREATE_SUSPENDED | CREATE_NO_WINDOW
            Check(CreateProcessW(file, commandLine, IntPtr.Zero, IntPtr.Zero, true, 0x08000004,
                IntPtr.Zero, null, ref startup, out info));
            using (var child = new SafeFileHandle(info.Process, true))
            using (var thread = new SafeFileHandle(info.Thread, true)) {
                if (!AssignProcessToJobObject(job, child.DangerousGetHandle())) {
                    int code = Marshal.GetLastWin32Error();
                    TerminateProcess(child, 125);
                    throw new Win32Exception(code);
                }
                Check(ResumeThread(thread) != UInt32.MaxValue);
                var handles = new IntPtr[] { child.DangerousGetHandle(), parent.DangerousGetHandle() };
                uint completed = WaitForMultipleObjects(2, handles, false, UInt32.MaxValue);
                if (completed == 1) return 125; // Node exited. Dispose the entire job.
                Check(completed == 0);
                uint status;
                Check(GetExitCodeProcess(child, out status));
                return unchecked((int)status);
            }
        }
    }
}
'@
    $program = $env:RCA_JOB_EXECUTABLE
    $arguments = $env:RCA_JOB_ARGUMENTS
    $ownerPid = [uint32]$env:RCA_JOB_PARENT
    [Environment]::SetEnvironmentVariable('RCA_JOB_EXECUTABLE', $null)
    [Environment]::SetEnvironmentVariable('RCA_JOB_ARGUMENTS', $null)
    [Environment]::SetEnvironmentVariable('RCA_JOB_PARENT', $null)
    $status = [RcaProcessJob]::Run($program, $arguments, $ownerPid)
    exit $status
} catch {
    [Console]::Error.WriteLine('RCA_WINDOWS_JOB_START_FAILED')
    exit 125
}
