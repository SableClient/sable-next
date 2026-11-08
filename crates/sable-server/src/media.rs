use std::sync::Arc;

use axum::{
    Extension,
    body::Bytes,
    extract::{Path as AxumPath, Query},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sable_core::protocol::RpcError;
use serde::{Deserialize, de::DeserializeOwned};

use crate::UserRuntime;

#[derive(Deserialize)]
pub(super) struct MediaQuery {
    width: Option<u32>,
    height: Option<u32>,
    background: Option<bool>,
    source: Option<String>,
    inline: Option<bool>,
}

pub(super) async fn media(
    Extension(runtime): Extension<Arc<UserRuntime>>,
    AxumPath((media_server, media_id)): AxumPath<(String, String)>,
    Query(query): Query<MediaQuery>,
) -> Response {
    let source = query
        .source
        .and_then(|source| URL_SAFE_NO_PAD.decode(source).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_else(|| format!("mxc://{media_server}/{media_id}"));
    let bytes = match runtime
        .core
        .fetch_media(
            source,
            query.width.unwrap_or(0),
            query.height.unwrap_or(0),
            query.background.unwrap_or(false),
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(error) => return rpc_error_response(error),
    };
    let content_type = if query.width.unwrap_or(0) > 0 || query.height.unwrap_or(0) > 0 {
        "image/jpeg"
    } else {
        "application/octet-stream"
    };
    let mut response = (StatusCode::OK, bytes).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    let disposition = if query.inline.unwrap_or(false) && content_type.starts_with("image/") {
        "inline"
    } else {
        "attachment"
    };
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static(disposition),
    );
    response
}

pub(super) async fn upload(
    Extension(runtime): Extension<Arc<UserRuntime>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    match runtime.core.upload_media(mime, body.into()).await {
        Ok(uri) => (StatusCode::OK, axum::Json(uri)).into_response(),
        Err(error) => rpc_error_response(error),
    }
}

pub(super) async fn rtc_data(
    Extension(runtime): Extension<Arc<UserRuntime>>,
    AxumPath(session_id): AxumPath<String>,
    body: Bytes,
) -> Response {
    match runtime.core.rtc_data(&session_id, &body).await {
        Ok(bytes) => {
            let mut response = (StatusCode::OK, bytes).into_response();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/octet-stream"),
            );
            response
        }
        Err(error) => rpc_error_response(error),
    }
}

#[derive(Deserialize)]
pub(super) struct ForgetMediaRequest {
    source: String,
}

pub(super) async fn forget_media(
    Extension(runtime): Extension<Arc<UserRuntime>>,
    axum::Json(request): axum::Json<ForgetMediaRequest>,
) -> Response {
    match runtime.core.forget_media(request.source).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => rpc_error_response(error),
    }
}

pub(super) async fn send_attachment(
    Extension(runtime): Extension<Arc<UserRuntime>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Ok(request) = decode_carried::<sable_core::protocol::SendAttachmentRequest>(&headers)
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match runtime.core.send_attachment(request, body.into()).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => rpc_error_response(error),
    }
}

pub(super) async fn send_gallery(
    Extension(runtime): Extension<Arc<UserRuntime>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Ok(request) = decode_carried::<sable_core::protocol::SendGalleryRequest>(&headers) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match runtime.core.send_gallery(request, body.into()).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => rpc_error_response(error),
    }
}

fn decode_carried<T: DeserializeOwned>(headers: &HeaderMap) -> Result<T, ()> {
    let Some(encoded) = headers
        .get("x-sable-request")
        .and_then(|value| value.to_str().ok())
    else {
        return Err(());
    };
    URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| ())
        .and_then(|request| serde_json::from_slice(&request).map_err(|_| ()))
}

fn rpc_error_response(error: RpcError) -> Response {
    (StatusCode::BAD_GATEWAY, axum::Json(error)).into_response()
}
