/// A call the runtime cannot honour. These are bugs in the caller, not user
/// errors, so shells report them as an opaque failure and log the detail.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
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
