use std::{borrow::Cow, collections::HashSet, error::Error, hash::Hasher, path::Path};

use sable_core::protocol::{
    AttachmentInfoView, CoreEvent, RpcError, SendAttachmentRequest, SendGalleryRequest,
};
use sable_runtime::{Batch, Handshake, Slice, SubscribeRequest, Subscribed};
use sable_slices::{
    CORE_METHODS,
    rooms::{Rooms, RoomsAction, RoomsView},
    sidebar::{Sidebar, SidebarAction, SidebarNotice, SidebarView},
    timeline::{Timeline, TimelineAction, TimelineDocView, TimelineKey, TimelinePaginated},
};
use specta::{Format, FormatError, Types, datatype::DataType};

#[derive(specta::Type)]
enum NoNotice {}

struct ProtocolFormat;

/// Marks a field the wire leaves out at its default. The serde attribute is
/// removed first because specta-serde cannot represent it in one shape.
const OMITTED: &str = "sable:omitted";
const SKIP_SERIALIZING_IF: &str = "serde:field:skip_serializing_if";

impl Format for ProtocolFormat {
    fn map_types(&'_ self, types: &Types) -> Result<Cow<'_, Types>, FormatError> {
        let mut marked = types.clone();
        marked.iter_mut(|ty| {
            if let Some(dt) = &mut ty.ty {
                for_named_fields(dt, &mut mark_omitted);
            }
        });
        let mut output = specta_serde::Format.map_types(&marked)?.into_owned();
        output.iter_mut(|ty| {
            if let Some(dt) = &mut ty.ty {
                for_named_fields(dt, &mut require_unless_omitted);
            }
        });
        Ok(Cow::Owned(output))
    }

    /// Inline types are RPC params and results, so serde decides which fields may be left out.
    fn map_type(&'_ self, types: &Types, dt: &DataType) -> Result<Cow<'_, DataType>, FormatError> {
        specta_serde::Format.map_type(types, dt)
    }
}

fn for_named_fields(dt: &mut DataType, edit: &mut impl FnMut(&mut specta::datatype::Field)) {
    let mut fields_of = |fields: &mut specta::datatype::Fields| {
        if let specta::datatype::Fields::Named(fields) = fields {
            for (_, field) in &mut fields.fields {
                edit(field);
            }
        }
    };
    match dt {
        DataType::Struct(value) => fields_of(&mut value.fields),
        DataType::Enum(value) => {
            for (_, variant) in &mut value.variants {
                fields_of(&mut variant.fields);
            }
        }
        _ => {}
    }
}

fn mark_omitted(field: &mut specta::datatype::Field) {
    if !field.attributes.remove(SKIP_SERIALIZING_IF) {
        return;
    }
    field.attributes.insert(OMITTED, true);
    field.ty = match field.ty.take() {
        Some(DataType::Nullable(inner)) => Some(*inner),
        other => other,
    };
}

fn require_unless_omitted(field: &mut specta::datatype::Field) {
    field.optional = field.attributes.contains_key(OMITTED);
}

fn render(
    exporter: &specta_typescript::FrameworkExporter<'_>,
    dt: &DataType,
) -> Result<String, specta_typescript::Error> {
    match dt {
        DataType::Reference(reference) => exporter.reference(reference),
        DataType::Nullable(inner) => Ok(format!("{} | null", render(exporter, inner)?)),
        dt => exporter.inline(dt),
    }
}

fn camel_case(snake: &str) -> String {
    let mut out = String::with_capacity(snake.len());
    let mut upper = false;
    for character in snake.chars() {
        if character == '_' {
            upper = true;
        } else if upper {
            out.extend(character.to_uppercase());
            upper = false;
        } else {
            out.push(character);
        }
    }
    out
}

/// The `Rpc` type, its wire map and `createRpc`, after the exported types.
fn rpc_client(
    mut exporter: specta_typescript::FrameworkExporter<'_>,
    routes: &[(&'static str, Vec<sable_core::api::Route>)],
) -> Result<Cow<'static, str>, specta_typescript::Error> {
    let mut api_lines = Vec::new();
    let mut wire_lines = Vec::new();
    let mut client_lines = Vec::new();
    for (domain, methods) in routes {
        api_lines.push(format!("  {domain}: {{"));
        client_lines.push(format!("    {domain}: {{"));
        for route in methods {
            let name = camel_case(route.method);
            let wire = format!("{domain}.{}", route.method);
            let path = format!("Rpc['{domain}']['{name}']");
            let params = render(&exporter, &route.params)?;
            let ok = render(&exporter, &route.ok)?;
            let empty = exporter.inline(&route.params)? == "Record<string, never>";
            let (optional, default) = if empty { ("?", " = {}") } else { ("", "") };
            api_lines.push(format!(
                "    {name}: (params{optional}: {params}) => Promise<{ok}>;"
            ));
            wire_lines.push(format!("  '{wire}': {path};"));
            client_lines.push(format!(
                "      {name}: (params{default}) => call('{wire}', params) as ReturnType<{path}>,"
            ));
        }
        api_lines.push("  };".to_owned());
        client_lines.push("    },".to_owned());
    }
    let out = format!(
        "{}\n/** The core's methods by domain. */\nexport type Rpc = {{\n{}\n}};\n\n\
         type RpcMethod = (params: never) => Promise<unknown>;\n\n\
         export type RpcParams<M extends RpcMethod> = NonNullable<Parameters<M>[0]>;\n\n\
         export type RpcResult<M extends RpcMethod> = Awaited<ReturnType<M>>;\n\n\
         /** Each method by its wire name, for code that speaks the wire format. */\n\
         export type RpcMethods = {{\n{}\n}};\n\n\
         export type RpcCall = (method: keyof RpcMethods, params: unknown) => Promise<unknown>;\n\n\
         {}\n\n\
         /** Binds every method to `call` on its wire name. */\n\
         export function createRpc(call: RpcCall): Rpc {{\n  return {{\n{}\n  }};\n}}\n",
        exporter.render_types()?,
        api_lines.join("\n"),
        wire_lines.join("\n"),
        slices_interface(),
        client_lines.join("\n"),
    );
    Ok(Cow::Owned(out))
}

/// Each slice with the types its UI reads and sends, and the type of its key as TypeScript has it.
/// Registering the types and the `Slices` map come from one line, and the slice has to agree on
/// its key and its action.
macro_rules! slices {
    ($($slice:ty => $view:ty, $action:ty, $key:ty = $ts_key:literal, $notice:ty;)+) => {
        fn register_slices(types: Types) -> Types {
            $(
                same_key_and_action::<$slice, $key, $action>();
                let types = types
                    .register::<$view>()
                    .register::<$action>()
                    .register::<$notice>();
            )+
            types
        }

        /// The `Slices` interface of the generated TypeScript.
        fn slices_interface() -> String {
            let mut lines = vec![
                "/** What each slice of the runtime serves and accepts, and what it tells besides its view. */".to_owned(),
                "export interface Slices {".to_owned(),
            ];
            $(lines.push(format!(
                "  {}: {{ key: {}; view: {}; action: {}; notice: {} }};",
                <$slice as Slice>::NAME,
                $ts_key,
                stringify!($view),
                stringify!($action),
                stringify!($notice),
            ));)+
            lines.push("}".to_owned());
            lines.join("\n")
        }
    };
}

const fn same_key_and_action<S: Slice<Key = K, Action = A>, K, A>() {}

slices! {
    Timeline => TimelineDocView, TimelineAction, TimelineKey = "TimelineKey", NoNotice;
    Rooms => RoomsView, RoomsAction, () = "null", NoNotice;
    Sidebar => SidebarView, SidebarAction, () = "null", SidebarNotice;
}

#[expect(
    clippy::too_many_lines,
    reason = "type generation keeps its registrations together"
)]
fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let check = match (args.next(), args.next()) {
        (None, None) => false,
        (Some(arg), None) if arg == "--check" => true,
        _ => return Err("usage: generate-types [--check]".into()),
    };

    let types = specta::Types::default()
        .register::<RpcError>()
        .register::<CoreEvent>()
        .register::<AttachmentInfoView>()
        .register::<SendAttachmentRequest>()
        .register::<SendGalleryRequest>()
        .register::<Batch>()
        .register::<Handshake>()
        .register::<SubscribeRequest>()
        .register::<Subscribed>()
        .register::<sable_model::search_query::ParsedQuery>()
        .register::<sable_model::matrix_link::MatrixLink>()
        .register::<sable_model::matrix_link::ViaSplit>()
        .register::<sable_model::matrix_link::JoinAddress>()
        .register::<sable_model::bot_commands::BotCommand>()
        .register::<sable_model::bot_commands::BotCommandDescription>()
        .register::<sable_model::bot_commands::BotCommandMatch>()
        .register::<sable_model::bot_commands::ArgumentDraft>()
        .register::<sable_model::bot_commands::InvocationResult>()
        .register::<sable_model::notifications::PushNotification>()
        .register::<sable_model::notifications::WebPushValidation>()
        .register::<sable_model::notifications::PushAlert>()
        .register::<sable_model::member_look::MemberLookEdit>()
        .register::<sable_model::slash::SlashParse>()
        .register::<sable_model::mfm::MfmColor>()
        .register::<sable_model::mfm::MfmUnixtime>()
        .register::<sable_model::mfm::ZonedInstant>()
        .register::<sable_model::calendar::CalendarItem>()
        .register::<sable_model::calendar::RsvpTally>()
        .register::<sable_model::calendar::EventDraft>()
        .register::<sable_model::spaces::HierarchySection>()
        .register::<sable_model::spaces::JoinCandidate>()
        .register::<sable_model::spaces::LobbyAction>()
        .register::<sable_model::event_preview::EventPreview>()
        .register::<sable_model::power_levels::PermissionGroup>()
        .register::<sable_model::search_filter::ResolvedQuery>()
        .register::<sable_model::search_filter::SearchDirectory>()
        .register::<sable_model::search_filter::TargetSuggestion>()
        .register::<sable_model::notifications::OwnPresence>()
        .register::<sable_model::sidebar::LayoutRef>()
        .register::<sable_model::sidebar::DropInstruction>()
        .register::<sable_model::spaces::SectionInputs>()
        .register::<sable_model::spaces::ChildOrderOverride>()
        .register::<sable_model::spaces::SuggestedOverride>();
    let mut types = register_slices(types)
        .register::<sable_slices::rooms::RoomsStatus>()
        .register::<TimelineKey>()
        .register::<TimelinePaginated>()
        .register::<sable_model::timeline::TimelineGroupInput>();
    let routes = sable_core::api::routes(&mut types);
    let known: HashSet<String> = routes
        .iter()
        .flat_map(|(domain, methods)| {
            methods
                .iter()
                .map(move |route| format!("{domain}.{}", route.method))
        })
        .collect();
    let missing: Vec<&str> = CORE_METHODS
        .into_iter()
        .filter(|method| !known.contains(*method))
        .collect();
    if !missing.is_empty() {
        return Err(format!("the slices call methods the core does not have: {missing:?}").into());
    }
    let output = specta_typescript::Exporter::from(specta_typescript::Typescript::default())
        .framework_runtime(move |exporter| rpc_client(exporter, &routes))
        .export(&types, ProtocolFormat)?;
    let output = format!(
        "{}\n",
        output
            .lines()
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n")
    );
    let mut hasher = fnv::FnvHasher::default();
    hasher.write(output.as_bytes());
    let schema = format!("{:016x}", hasher.finish());
    let output = format!("{output}\nexport const WIRE_SCHEMA = '{schema}';\n");
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let generated = [
        (root.join("src/generated/protocol.ts"), output),
        (root.join("crates/sable-runtime/schema.hash"), schema),
    ];

    for (path, content) in generated {
        if check {
            if std::fs::read_to_string(&path).ok().as_deref() != Some(content.as_str()) {
                return Err(
                    "generated protocol is missing or stale; run `mise run generate:types`".into(),
                );
            }
        } else {
            std::fs::write(path, content)?;
        }
    }

    Ok(())
}
