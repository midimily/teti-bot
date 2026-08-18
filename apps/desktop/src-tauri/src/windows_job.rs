use std::{
    mem::size_of,
    os::windows::io::AsRawHandle,
    process::Child,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
};

pub struct WindowsJob {
    handle: HANDLE,
}

// A Job Object handle may be closed or used to terminate the Job from any
// thread. Access stays synchronized by LifecycleBridge's process mutex.
unsafe impl Send for WindowsJob {}

impl WindowsJob {
    pub fn new() -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(format!(
                "Could not create Runtime descendant ownership: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                let _ = CloseHandle(handle);
            }
            return Err(format!(
                "Could not configure Runtime descendant ownership: {error}"
            ));
        }
        Ok(Self { handle })
    }

    pub fn assign(&self, child: &Child) -> Result<(), String> {
        let process = child.as_raw_handle().cast();
        if unsafe { AssignProcessToJobObject(self.handle, process) } == 0 {
            return Err(format!(
                "Could not assign the lifecycle Runtime to its Job Object: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    pub fn terminate(&self) {
        unsafe {
            let _ = TerminateJobObject(self.handle, 1);
        }
    }

    #[cfg(test)]
    fn active_processes(&self) -> Result<u32, String> {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        };
        let mut information = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let ok = unsafe {
            QueryInformationJobObject(
                self.handle,
                JobObjectBasicAccountingInformation,
                (&mut information as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(information.ActiveProcesses)
    }
}

impl Drop for WindowsJob {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
            self.handle = null_mut();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{process::Command, thread, time::Duration};

    #[test]
    fn job_termination_removes_the_runtime_and_its_descendant() {
        let job = WindowsJob::new().unwrap();
        let mut runtime = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$child=Start-Process $env:ComSpec -ArgumentList '/c','ping -t 127.0.0.1' -WindowStyle Hidden -PassThru; Start-Sleep -Seconds 30",
            ])
            .spawn()
            .unwrap();
        job.assign(&runtime).unwrap();

        let mut observed_descendant = false;
        for _ in 0..100 {
            if job.active_processes().unwrap() >= 2 {
                observed_descendant = true;
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        assert!(
            observed_descendant,
            "the fixture must create a Job-owned descendant"
        );

        job.terminate();
        runtime.wait().unwrap();
        for _ in 0..100 {
            if job.active_processes().unwrap() == 0 {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("a Runtime descendant survived Job termination");
    }
}
