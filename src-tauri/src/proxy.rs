use std::ffi::OsString;
use std::sync::OnceLock;

#[cfg(all(feature = "cef", target_os = "linux"))]
const SCHEMES: [&str; 4] = ["http", "socks", "socks4", "socks5"];
#[cfg(not(all(feature = "cef", target_os = "linux")))]
const SCHEMES: [&str; 2] = ["http", "socks5"];

static LAUNCH: OnceLock<Result<Option<String>, String>> = OnceLock::new();
static CORE_ERROR: OnceLock<String> = OnceLock::new();

pub fn launch_proxy() -> &'static Result<Option<String>, String> {
    LAUNCH.get_or_init(|| from_args(std::env::args_os().skip(1)))
}

pub fn apply_to_core() {
    if let Ok(Some(proxy)) = launch_proxy()
        && let Err(error) = sable_core::tls::set_proxy(&for_core(proxy))
    {
        let _ = CORE_ERROR.set(format!("--proxy cannot be used: {error}"));
    }
}

pub fn launch_error() -> Option<&'static str> {
    match launch_proxy() {
        Err(error) => Some(error),
        Ok(_) => CORE_ERROR.get().map(String::as_str),
    }
}

fn from_args(args: impl IntoIterator<Item = OsString>) -> Result<Option<String>, String> {
    let mut args = args.into_iter();
    let mut proxy = None;

    while let Some(argument) = args.next() {
        let Some(argument) = argument.to_str() else {
            continue;
        };
        let value = match argument.strip_prefix("--proxy=") {
            Some(value) => value.to_owned(),
            None if argument == "--proxy" => args
                .next()
                .and_then(|value| value.into_string().ok())
                .ok_or_else(|| "--proxy requires an HTTP or SOCKS proxy URL".to_owned())?,
            None => continue,
        };

        if proxy.is_some() {
            return Err("--proxy may only be specified once".to_owned());
        }
        proxy = Some(normalize(&value)?);
    }

    Ok(proxy)
}

fn normalize(value: &str) -> Result<String, String> {
    let proxy = tauri::Url::parse(value.trim())
        .map_err(|_| "--proxy must be an HTTP or SOCKS proxy URL".to_owned())?;
    if !SCHEMES.contains(&proxy.scheme()) {
        return Err(format!("--proxy must use {}", SCHEMES.join(", ")));
    }
    if !proxy.username().is_empty() || proxy.password().is_some() {
        return Err("--proxy does not support credentials".to_owned());
    }
    if !matches!(proxy.path(), "" | "/") || proxy.query().is_some() || proxy.fragment().is_some() {
        return Err("--proxy must not include a path, query, or fragment".to_owned());
    }

    let host = proxy
        .host_str()
        .ok_or_else(|| "--proxy requires a host".to_owned())?;
    let port = proxy
        .port()
        .map_or_else(String::new, |port| format!(":{port}"));

    Ok(format!("{}://{host}{port}", proxy.scheme()))
}

fn for_core(proxy: &str) -> String {
    for (webview, core) in [
        ("socks5://", "socks5h://"),
        ("socks4://", "socks4a://"),
        ("socks://", "socks4a://"),
    ] {
        if let Some(rest) = proxy.strip_prefix(webview) {
            return format!("{core}{rest}");
        }
    }
    proxy.to_owned()
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::{for_core, from_args};

    #[test]
    fn accepts_a_socks_proxy() {
        let args = ["--proxy", "socks5://[::1]:9050"].map(OsString::from);

        assert_eq!(from_args(args), Ok(Some("socks5://[::1]:9050".into())));
    }

    #[test]
    fn accepts_an_equals_proxy() {
        let args = ["--proxy=socks5://127.0.0.1:9050"].map(OsString::from);

        assert_eq!(from_args(args), Ok(Some("socks5://127.0.0.1:9050".into())));
    }

    #[test]
    fn accepts_an_http_proxy_with_a_trailing_slash() {
        let args = ["--proxy=http://proxy.example:8080/"].map(OsString::from);

        assert_eq!(
            from_args(args),
            Ok(Some("http://proxy.example:8080".into()))
        );
    }

    #[test]
    fn rejects_an_invalid_proxy() {
        let args = ["--proxy=https://proxy.example"].map(OsString::from);

        assert!(from_args(args).is_err_and(|error| error.starts_with("--proxy must use")));
    }

    #[test]
    fn rejects_a_path() {
        let args = ["--proxy=socks5://127.0.0.1:9050/tor"].map(OsString::from);

        assert_eq!(
            from_args(args),
            Err("--proxy must not include a path, query, or fragment".into())
        );
    }

    #[test]
    fn resolves_names_through_a_socks_proxy_in_the_core() {
        assert_eq!(
            for_core("socks5://127.0.0.1:9050"),
            "socks5h://127.0.0.1:9050"
        );
        assert_eq!(
            for_core("http://proxy.example:8080"),
            "http://proxy.example:8080"
        );
    }
}
