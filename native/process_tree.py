"""Own a worker and descendants; Windows closes the whole tree with the host."""
import ctypes
import os
import signal
import subprocess
import threading


class ProcessTree:
    def __init__(self, process):
        self.process = process
        self.handle = None
        self.lock = threading.RLock()
        if os.name != 'nt':
            return
        from ctypes import wintypes

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in (
                'ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount',
                'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]

        class BASIC(ctypes.Structure):
            _fields_ = [('PerProcessUserTimeLimit', ctypes.c_int64), ('PerJobUserTimeLimit', ctypes.c_int64),
                        ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                        ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD),
                        ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD), ('SchedulingClass', wintypes.DWORD)]

        class EXTENDED(ctypes.Structure):
            _fields_ = [('BasicLimitInformation', BASIC), ('IoInfo', IO_COUNTERS),
                        ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                        ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]

        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = self.kernel.CreateJobObjectW(None, None)
        if not handle:
            process.kill()
            process.wait(timeout=5)
            raise OSError('Cannot create worker process job')
        limits = EXTENDED()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
        if not self.kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not self.kernel.AssignProcessToJobObject(handle, int(process._handle)):
            self.kernel.CloseHandle(handle)
            process.kill()
            process.wait(timeout=5)
            raise OSError('Cannot isolate worker process tree')
        self.handle = handle

    @staticmethod
    def popen_options():
        return {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {'start_new_session': True}

    def terminate(self):
        with self.lock:
            self._terminate()

    def _terminate(self):
        if self.handle:
            self.kernel.TerminateJobObject(self.handle, 2)
        elif self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            self.process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            if self.handle:
                self.kernel.TerminateJobObject(self.handle, 2)
            else:
                os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)

    def close(self):
        with self.lock:
            if self.handle:
                self.kernel.CloseHandle(self.handle)
                self.handle = None
