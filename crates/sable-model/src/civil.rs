//! Proleptic Gregorian dates as days since 1970, after Howard Hinnant's
//! `days_from_civil` and `civil_from_days`. Months are 1-based.

pub(crate) const MS_PER_DAY: i64 = 86_400_000;

pub(crate) const fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

pub(crate) const fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

pub(crate) const fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// 0 for Sunday.
pub(crate) const fn weekday(days: i64) -> i64 {
    (days + 4).rem_euclid(7)
}

/// Milliseconds since 1970 as `YYYY-MM-DDTHH:MM:SS`, read in UTC.
pub(crate) fn format_ms(ms: i64) -> String {
    let (year, month, day) = civil_from_days(ms.div_euclid(MS_PER_DAY));
    let clock = ms.rem_euclid(MS_PER_DAY) / 1000;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}",
        clock / 3600,
        clock % 3600 / 60,
        clock % 60
    )
}
