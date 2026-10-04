//! Windows Graphics Capture in `R16G16B16A16Float`, the path OBS takes for an
//! HDR monitor, converted to SDR BGRA before it leaves this crate.

use std::sync::{Arc, Mutex};

use windows::Win32::Devices::Display::{
    DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
    DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL, DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
    DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_DEVICE_INFO_TYPE,
    DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
    DISPLAYCONFIG_SDR_WHITE_LEVEL, DISPLAYCONFIG_SOURCE_DEVICE_NAME, DisplayConfigGetDeviceInfo,
    GetDisplayConfigBufferSizes, QDC_ONLY_ACTIVE_PATHS, QueryDisplayConfig,
};
use windows::Win32::Foundation::{ERROR_SUCCESS, LUID};
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

use crate::{HdrToSdr, OBS_PEAK_NITS, OBS_SDR_WHITE_NITS};

/// Windows reports SDR white in thousandths of the 80-nit scRGB unit.
const SDR_WHITE_LEVEL_UNIT: f32 = 80.0 / 1000.0;
const ADVANCED_COLOR_ENABLED: u32 = 1 << 1;

#[derive(Debug, Clone)]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub hdr: bool,
    pub sdr_white_nits: f32,
}

struct DisplayState {
    hdr: bool,
    sdr_white_nits: Option<f32>,
}

fn header<T>(
    kind: DISPLAYCONFIG_DEVICE_INFO_TYPE,
    adapter: LUID,
    id: u32,
) -> DISPLAYCONFIG_DEVICE_INFO_HEADER {
    DISPLAYCONFIG_DEVICE_INFO_HEADER {
        r#type: kind,
        size: u32::try_from(size_of::<T>()).unwrap_or(0),
        adapterId: adapter,
        id,
    }
}

#[expect(unsafe_code, reason = "FFI call")]
fn display_state(gdi_device_name: &str) -> Option<DisplayState> {
    let (mut path_count, mut mode_count) = (0u32, 0u32);
    // SAFETY: both counts are valid out-pointers for the duration of the call.
    let sized = unsafe {
        GetDisplayConfigBufferSizes(
            QDC_ONLY_ACTIVE_PATHS,
            &raw mut path_count,
            &raw mut mode_count,
        )
    };
    if sized != ERROR_SUCCESS {
        return None;
    }
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
    let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
    // SAFETY: the buffers hold exactly the element counts passed alongside them.
    let queried = unsafe {
        QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &raw mut path_count,
            paths.as_mut_ptr(),
            &raw mut mode_count,
            modes.as_mut_ptr(),
            None,
        )
    };
    if queried != ERROR_SUCCESS {
        return None;
    }
    paths.truncate(path_count as usize);

    for path in paths {
        let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
            header: header::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>(
                DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                path.sourceInfo.adapterId,
                path.sourceInfo.id,
            ),
            ..Default::default()
        };
        // SAFETY: the header is the first field and carries the struct's own size.
        if unsafe { DisplayConfigGetDeviceInfo(&raw mut source.header) } != 0 {
            continue;
        }
        let length = source
            .viewGdiDeviceName
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(32);
        let name = String::from_utf16_lossy(source.viewGdiDeviceName.get(..length).unwrap_or(&[]));
        if name != gdi_device_name {
            continue;
        }

        let (adapter, target) = (path.targetInfo.adapterId, path.targetInfo.id);
        let mut color = DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO {
            header: header::<DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO>(
                DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
                adapter,
                target,
            ),
            ..Default::default()
        };
        let mut white = DISPLAYCONFIG_SDR_WHITE_LEVEL {
            header: header::<DISPLAYCONFIG_SDR_WHITE_LEVEL>(
                DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL,
                adapter,
                target,
            ),
            SDRWhiteLevel: 0,
        };
        // SAFETY: as above, the header describes the struct it heads.
        let color_ok = unsafe { DisplayConfigGetDeviceInfo(&raw mut color.header) } == 0;
        // SAFETY: as above, the header describes the struct it heads.
        let white_ok = unsafe { DisplayConfigGetDeviceInfo(&raw mut white.header) } == 0;
        // SAFETY: the union is a plain bitfield word whichever member is read.
        let flags = unsafe { color.Anonymous.value };
        return Some(DisplayState {
            hdr: color_ok && flags & ADVANCED_COLOR_ENABLED != 0,
            #[expect(
                clippy::cast_precision_loss,
                reason = "lossy conversion is display-only"
            )]
            sdr_white_nits: (white_ok && white.SDRWhiteLevel > 0)
                .then_some(white.SDRWhiteLevel as f32 * SDR_WHITE_LEVEL_UNIT),
        });
    }
    None
}

/// Every active monitor, whether it is in HDR mode and the SDR white level the
/// user set for it in Windows' HDR settings.
#[must_use]
pub fn monitors() -> Vec<MonitorInfo> {
    Monitor::enumerate()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(index, monitor)| {
            let state = monitor
                .device_name()
                .ok()
                .and_then(|device| display_state(&device));
            MonitorInfo {
                index,
                name: monitor
                    .name()
                    .unwrap_or_else(|_| format!("Display {}", index + 1)),
                hdr: state.as_ref().is_some_and(|state| state.hdr),
                sdr_white_nits: state
                    .and_then(|state| state.sdr_white_nits)
                    .unwrap_or(OBS_SDR_WHITE_NITS),
            }
        })
        .collect()
}

pub type FrameSink = Box<dyn FnMut(u32, u32, &[u8]) + Send>;

struct Flags {
    convert: HdrToSdr,
    sink: FrameSink,
}

struct Handler {
    convert: HdrToSdr,
    sink: FrameSink,
    out: Vec<u8>,
}

impl GraphicsCaptureApiHandler for Handler {
    type Flags = Arc<Mutex<Option<Flags>>>;
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let flags = ctx
            .flags
            .lock()
            .map_err(|_| "capture settings are poisoned".to_owned())?
            .take()
            .ok_or_else(|| "capture settings were already taken".to_owned())?;
        Ok(Self {
            convert: flags.convert,
            sink: flags.sink,
            out: Vec::new(),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let (width, height) = (frame.width(), frame.height());
        let mut buffer = frame.buffer().map_err(|error| error.to_string())?;
        let pitch = buffer.row_pitch() as usize;
        let out_stride = width as usize * 4;
        self.out.resize(out_stride * height as usize, 0);
        self.convert.frame(
            buffer.as_raw_buffer(),
            pitch,
            &mut self.out,
            out_stride,
            HdrToSdr::scrgb_bytes_row,
        );
        (self.sink)(width, height, &self.out);
        Ok(())
    }
}

pub struct HdrCapture {
    control: CaptureControl<Handler, String>,
}

impl HdrCapture {
    /// Starts capturing monitor `index` in 16-bit float and hands every
    /// converted BGRA frame to `sink` on the capture thread.
    ///
    /// # Errors
    ///
    /// Fails when the monitor does not exist or the capture cannot start.
    pub fn start(index: usize, sink: FrameSink) -> Result<Self, String> {
        let monitor = Monitor::enumerate()
            .map_err(|error| error.to_string())?
            .into_iter()
            .nth(index)
            .ok_or_else(|| format!("no monitor {index}"))?;
        let white = monitors()
            .into_iter()
            .find(|info| info.index == index)
            .map_or(OBS_SDR_WHITE_NITS, |info| info.sdr_white_nits);
        let flags = Arc::new(Mutex::new(Some(Flags {
            convert: HdrToSdr::new(white, OBS_PEAK_NITS),
            sink,
        })));
        let settings = Settings::new(
            monitor,
            CursorCaptureSettings::Default,
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Rgba16F,
            flags,
        );
        let control = Handler::start_free_threaded(settings).map_err(|error| error.to_string())?;
        Ok(Self { control })
    }

    /// # Errors
    ///
    /// Fails when the capture thread reports an error while stopping.
    pub fn stop(self) -> Result<(), String> {
        self.control.stop().map_err(|error| error.to_string())
    }
}
