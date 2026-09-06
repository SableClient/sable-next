use std::{borrow::Cow, error::Error, path::Path};

use sable_core::protocol::{AttachmentInfoView, Command, CommandErr, CommandOk, CoreEvent};
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

    fn map_type(&'_ self, types: &Types, dt: &DataType) -> Result<Cow<'_, DataType>, FormatError> {
        let mut output = specta_serde::Format.map_type(types, dt)?.into_owned();
        require_fields(&mut output);
        Ok(Cow::Owned(output))
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

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let check = match (args.next(), args.next()) {
        (None, None) => false,
        (Some(arg), None) if arg == "--check" => true,
        _ => return Err("usage: generate-types [--check]".into()),
    };

    let types = specta::Types::default()
        .register::<Command>()
        .register::<CommandOk>()
        .register::<CommandErr>()
        .register::<CoreEvent>()
        .register::<AttachmentInfoView>();
    let output = specta_typescript::Typescript::default().export(&types, ProtocolFormat)?;
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/generated/protocol.ts");

    if check {
        if std::fs::read_to_string(&path).ok().as_deref() != Some(output.as_str()) {
            return Err(
                "generated protocol is missing or stale; run `mise run generate:types`".into(),
            );
        }
    } else {
        std::fs::write(path, output)?;
    }

    Ok(())
}
