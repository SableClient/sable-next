//! A portal screencast of one monitor, negotiated in the HDR layouts a GNOME
//! HDR monitor offers before the 8-bit ones, and converted to SDR BGRA.

use std::os::fd::OwnedFd;
use std::thread::JoinHandle;

use ashpd::desktop::screencast::{
    CursorMode, OpenPipeWireRemoteOptions, Screencast, SelectSourcesOptions, SourceType,
    StartCastOptions,
};
use ashpd::desktop::{CreateSessionOptions, PersistMode, Session};
use pipewire as pw;
use pw::properties::properties;
use pw::spa;
use pw::spa::param::video::{VideoFormat, VideoInfoRaw};
use pw::spa::pod::Pod;

use crate::{HdrToSdr, OBS_PEAK_NITS, Scratch, sdr_row};

/// BT.2408 graphics white: where PQ content puts the UI a reader calls white.
pub const PQ_REFERENCE_WHITE_NITS: f32 = 203.0;

const SPA_VIDEO_TRANSFER_SMPTE2084: spa::sys::spa_video_transfer_function = 14;

pub type FrameSink = Box<dyn FnMut(u32, u32, &[u8]) + Send>;

type Row = fn(&HdrToSdr, &[u8], &mut Scratch, &mut [u8]);

#[derive(Clone, Copy)]
enum Layout {
    Hdr(Row),
    Sdr { rgb: bool },
}

fn layout(info: &VideoInfoRaw) -> Option<Layout> {
    let pq = info.transfer_function() == SPA_VIDEO_TRANSFER_SMPTE2084;
    match info.format() {
        VideoFormat::RGBA_F16 if pq => Some(Layout::Hdr(HdrToSdr::pq_f16_bytes_row)),
        VideoFormat::RGBA_F16 => Some(Layout::Hdr(HdrToSdr::scrgb_bytes_row)),
        VideoFormat::xRGB_210LE if pq => Some(Layout::Hdr(HdrToSdr::pq_xrgb210_bytes_row)),
        VideoFormat::xBGR_210LE if pq => Some(Layout::Hdr(HdrToSdr::pq_xbgr210_bytes_row)),
        VideoFormat::BGRx | VideoFormat::BGRA => Some(Layout::Sdr { rgb: false }),
        VideoFormat::RGBx | VideoFormat::RGBA => Some(Layout::Sdr { rgb: true }),
        _ => None,
    }
}

struct Stream {
    convert: HdrToSdr,
    sink: FrameSink,
    layout: Option<Layout>,
    width: u32,
    height: u32,
    out: Vec<u8>,
}

impl Stream {
    fn frame(&mut self, bytes: &[u8], stride: usize) {
        let Some(layout) = self.layout else {
            return;
        };
        let out_stride = self.width as usize * 4;
        self.out.resize(out_stride * self.height as usize, 0);
        match layout {
            Layout::Hdr(row) => self
                .convert
                .frame(bytes, stride, &mut self.out, out_stride, row),
            Layout::Sdr { rgb } => {
                for (line, target) in bytes.chunks(stride).zip(self.out.chunks_mut(out_stride)) {
                    sdr_row(line, target, rgb);
                }
            }
        }
        (self.sink)(self.width, self.height, &self.out);
    }
}

fn format_pod() -> Result<Vec<u8>, String> {
    let object = spa::pod::object!(
        spa::utils::SpaTypes::ObjectParamFormat,
        spa::param::ParamType::EnumFormat,
        spa::pod::property!(
            spa::param::format::FormatProperties::MediaType,
            Id,
            spa::param::format::MediaType::Video
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::MediaSubtype,
            Id,
            spa::param::format::MediaSubtype::Raw
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            VideoFormat::RGBA_F16,
            VideoFormat::RGBA_F16,
            VideoFormat::xRGB_210LE,
            VideoFormat::xBGR_210LE,
            VideoFormat::BGRx,
            VideoFormat::BGRA,
            VideoFormat::RGBx,
            VideoFormat::RGBA
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            spa::utils::Rectangle {
                width: 1920,
                height: 1080
            },
            spa::utils::Rectangle {
                width: 1,
                height: 1
            },
            spa::utils::Rectangle {
                width: 8192,
                height: 8192
            }
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            spa::utils::Fraction { num: 30, denom: 1 },
            spa::utils::Fraction { num: 0, denom: 1 },
            spa::utils::Fraction { num: 240, denom: 1 }
        ),
    );
    spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(object),
    )
    .map(|(cursor, _)| cursor.into_inner())
    .map_err(|error| format!("{error:?}"))
}

fn run(
    node: u32,
    fd: OwnedFd,
    quit: pw::channel::Receiver<()>,
    sink: FrameSink,
) -> Result<(), String> {
    pw::init();
    let error = |error: pw::Error| error.to_string();
    let mainloop = pw::main_loop::MainLoopRc::new(None).map_err(error)?;
    let context = pw::context::ContextRc::new(&mainloop, None).map_err(error)?;
    let core = context.connect_fd_rc(fd, None).map_err(error)?;
    let stream = pw::stream::StreamRc::new(
        core,
        "sable-hdr",
        properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    )
    .map_err(error)?;

    let state = Stream {
        convert: HdrToSdr::new(PQ_REFERENCE_WHITE_NITS, OBS_PEAK_NITS),
        sink,
        layout: None,
        width: 0,
        height: 0,
        out: Vec::new(),
    };
    let _listener = stream
        .add_local_listener_with_user_data(state)
        .param_changed(|_, state, id, param| {
            let Some(param) = param else {
                return;
            };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            let mut info = VideoInfoRaw::default();
            if info.parse(param).is_err() {
                return;
            }
            state.layout = layout(&info);
            state.width = info.size().width;
            state.height = info.size().height;
            if state.layout.is_none() {
                log::warn!(
                    "the screencast offered {:?}, which cannot be shared",
                    info.format()
                );
            }
        })
        .state_changed({
            let mainloop = mainloop.clone();
            move |_, state, _, new| {
                if matches!(
                    new,
                    pw::stream::StreamState::Error(_) | pw::stream::StreamState::Unconnected
                ) {
                    (state.sink)(0, 0, &[]);
                    mainloop.quit();
                }
            }
        })
        .process(|stream, state| {
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let Some(data) = buffer.datas_mut().first_mut() else {
                return;
            };
            let chunk = data.chunk();
            let (offset, size) = (chunk.offset() as usize, chunk.size() as usize);
            let stride = usize::try_from(chunk.stride()).unwrap_or(0);
            if let Some(bytes) = data
                .data()
                .and_then(|bytes| bytes.get(offset..offset + size))
                && stride > 0
            {
                state.frame(bytes, stride);
            }
        })
        .register()
        .map_err(error)?;

    let _quit = quit.attach(mainloop.loop_(), {
        let mainloop = mainloop.clone();
        move |()| mainloop.quit()
    });

    let pod = format_pod()?;
    let mut params = [Pod::from_bytes(&pod).ok_or_else(|| "bad format pod".to_owned())?];
    stream
        .connect(
            spa::utils::Direction::Input,
            Some(node),
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut params,
        )
        .map_err(error)?;
    mainloop.run();
    Ok(())
}

pub struct HdrCapture {
    quit: pw::channel::Sender<()>,
    thread: Option<JoinHandle<()>>,
    _session: Session<Screencast>,
}

impl HdrCapture {
    /// Asks the portal for a monitor, then streams it on a worker thread,
    /// handing every converted BGRA frame to `sink`, and an empty one when
    /// the desktop ends the cast.
    ///
    /// # Errors
    ///
    /// Fails when the portal is unavailable or the reader cancels its dialog.
    pub async fn start(sink: FrameSink) -> Result<Self, String> {
        let error = |error: ashpd::Error| error.to_string();
        let proxy = Screencast::new().await.map_err(error)?;
        let session = proxy
            .create_session(CreateSessionOptions::default())
            .await
            .map_err(error)?;
        proxy
            .select_sources(
                &session,
                SelectSourcesOptions::default()
                    .set_cursor_mode(CursorMode::Embedded)
                    .set_sources(ashpd::enumflags2::BitFlags::from(SourceType::Monitor))
                    .set_multiple(false)
                    .set_persist_mode(PersistMode::DoNot),
            )
            .await
            .map_err(error)?;
        let response = proxy
            .start(&session, None, StartCastOptions::default())
            .await
            .map_err(error)?
            .response()
            .map_err(error)?;
        let node = response
            .streams()
            .first()
            .map(ashpd::desktop::screencast::Stream::pipe_wire_node_id)
            .ok_or_else(|| "the portal returned no stream".to_owned())?;
        let fd = proxy
            .open_pipe_wire_remote(&session, OpenPipeWireRemoteOptions::default())
            .await
            .map_err(error)?;

        let (quit, receiver) = pw::channel::channel::<()>();
        let thread = std::thread::Builder::new()
            .name("sable-hdr".to_owned())
            .spawn(move || {
                if let Err(error) = run(node, fd, receiver, sink) {
                    log::warn!("HDR screencast stopped: {error}");
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            quit,
            thread: Some(thread),
            _session: session,
        })
    }

    pub fn stop(mut self) {
        if self.quit.send(()).is_err() {
            log::debug!("the HDR screencast loop had already ended");
        }
        if let Some(thread) = self.thread.take()
            && thread.join().is_err()
        {
            log::warn!("the HDR screencast thread panicked");
        }
    }
}
