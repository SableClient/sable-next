use std::time::Duration;

const FIRST: Duration = Duration::from_secs(1);
const LONGEST: Duration = Duration::from_secs(30);

/// How long to wait before retry number `attempt`, counting from 0.
pub fn delay(attempt: u32) -> Duration {
    FIRST.saturating_mul(1 << attempt.min(5)).min(LONGEST)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubles_up_to_the_longest_wait() {
        let waits: Vec<_> = (0..8).map(delay).map(|wait| wait.as_secs()).collect();
        assert_eq!(waits, [1, 2, 4, 8, 16, 30, 30, 30]);
        assert_eq!(delay(100).as_secs(), 30);
    }
}
