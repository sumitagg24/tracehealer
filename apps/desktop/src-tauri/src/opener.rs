//! Opening URLs in the system browser.
//!
//! The shell only ever opens a URL it minted itself, and the operation is a
//! trait so tests can assert *what* would have been opened without launching a
//! real browser.

/// Something that can hand a URL to the operating system.
pub trait Opener: Send + Sync {
    fn open(&self, url: &str) -> std::result::Result<(), String>;
}

/// The real system browser.
pub struct SystemOpener;

impl Opener for SystemOpener {
    fn open(&self, url: &str) -> std::result::Result<(), String> {
        open::that(url).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
pub mod testing {
    use super::*;
    use std::sync::Mutex;

    /// Records every URL the shell wanted to open.
    #[derive(Default)]
    pub struct RecordingOpener {
        pub opened: Mutex<Vec<String>>,
        pub fail: bool,
    }

    impl RecordingOpener {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn failing() -> Self {
            Self {
                opened: Mutex::new(Vec::new()),
                fail: true,
            }
        }

        pub fn opened(&self) -> Vec<String> {
            self.opened.lock().expect("opener").clone()
        }
    }

    impl Opener for RecordingOpener {
        fn open(&self, url: &str) -> std::result::Result<(), String> {
            self.opened.lock().expect("opener").push(url.to_string());
            if self.fail {
                return Err("no browser is associated with this scheme".into());
            }
            Ok(())
        }
    }
}
