#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AppError {
    #[error("input is not valid for this call")]
    Invalid,
    #[error("input is larger than {limit} bytes")]
    TooLarge { limit: usize },
    #[error("no such slice")]
    UnknownSlice,
    #[error("no such subscription")]
    UnknownSub,
    #[error("the slice has stopped")]
    Stopped,
    #[error("the state does not serialize")]
    Encode,
}

impl AppError {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::TooLarge { .. } => "too_large",
            Self::UnknownSlice => "unknown_slice",
            Self::UnknownSub => "unknown_sub",
            Self::Stopped => "stopped",
            Self::Encode => "encode",
        }
    }
}
