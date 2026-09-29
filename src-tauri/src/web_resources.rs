use std::borrow::Cow;

use tauri::http::{Request, Response, header};

pub fn fix_content_type(request: Request<Vec<u8>>, response: &mut Response<Cow<'static, [u8]>>) {
    if request.uri().path() == "/manifest.webmanifest" {
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/manifest+json"),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_stays_json_before_cef_injects_html_scripts() {
        let request = Request::builder()
            .uri("tauri://localhost/manifest.webmanifest?version=1")
            .body(Vec::new())
            .unwrap();
        let body = Cow::Borrowed(include_bytes!("../../static/manifest.webmanifest").as_slice());
        let mut response = Response::builder()
            .header(header::CONTENT_TYPE, "text/html")
            .body(body.clone())
            .unwrap();

        fix_content_type(request, &mut response);

        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/manifest+json"
        );
        assert_eq!(response.body(), &body);
        assert!(serde_json::from_slice::<serde_json::Value>(response.body()).is_ok());
    }

    #[test]
    fn html_pages_keep_their_content_type() {
        let request = Request::builder()
            .uri("tauri://localhost/room/!example:example.org")
            .body(Vec::new())
            .unwrap();
        let mut response = Response::builder()
            .header(header::CONTENT_TYPE, "text/html")
            .body(Cow::Borrowed(b"<html></html>".as_slice()))
            .unwrap();

        fix_content_type(request, &mut response);

        assert_eq!(response.headers()[header::CONTENT_TYPE], "text/html");
    }
}
