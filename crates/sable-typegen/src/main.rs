use std::{borrow::Cow, error::Error, path::Path};

use sable_core::protocol::{
    AttachmentInfoView, CoreEvent, RpcError, SendAttachmentRequest, SendGalleryRequest,
};
use sable_runtime::{Batch, Handshake, SubscribeRequest, Subscribed, fnv1a_hex};
use specta::{Format, FormatError, Types, datatype::DataType};

struct ProtocolFormat;

impl Format for ProtocolFormat {
    fn map_types(&'_ self, types: &Types) -> Result<Cow<'_, Types>, FormatError> {
        let mut output = specta_serde::Format.map_types(types)?.into_owned();
        output.iter_mut(|ty| {
            if let Some(dt) = &mut ty.ty {
                require_fields(dt);
            }
        });
        Ok(Cow::Owned(output))
    }

    /// Inline types are RPC params and results, so serde decides which fields may be left out.
    fn map_type(&'_ self, types: &Types, dt: &DataType) -> Result<Cow<'_, DataType>, FormatError> {
        specta_serde::Format.map_type(types, dt)
    }
}

fn require_fields(dt: &mut DataType) {
    match dt {
        DataType::Struct(value) => require_named_fields(&mut value.fields),
        DataType::Enum(value) => {
            for (_, variant) in &mut value.variants {
                require_named_fields(&mut variant.fields);
            }
        }
        _ => {}
    }
}

fn require_named_fields(fields: &mut specta::datatype::Fields) {
    if let specta::datatype::Fields::Named(fields) = fields {
        for (_, field) in &mut fields.fields {
            field.optional = false;
        }
    }
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
         /** Binds every method to `call` on its wire name. */\n\
         export function createRpc(call: RpcCall): Rpc {{\n  return {{\n{}\n  }};\n}}\n",
        exporter.render_types()?,
        api_lines.join("\n"),
        wire_lines.join("\n"),
        client_lines.join("\n"),
    );
    Ok(Cow::Owned(out))
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let check = match (args.next(), args.next()) {
        (None, None) => false,
        (Some(arg), None) if arg == "--check" => true,
        _ => return Err("usage: generate-types [--check]".into()),
    };

    let mut types = specta::Types::default()
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
        .register::<sable_model::search_filter::TargetSuggestion>();
    let routes = sable_core::api::routes(&mut types);
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
    let schema = fnv1a_hex(&output);
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
