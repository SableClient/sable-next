//! The local message search engine: text to terms, queries to full-text expressions. No
//! I/O and no SDK, so its tests build without the core.

pub mod matching;
pub mod phrase;
mod tokenize;
