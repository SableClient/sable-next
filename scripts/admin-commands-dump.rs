use std::any::TypeId;

use clap::{Arg, ArgAction, Command, CommandFactory, builder::ValueParser};
use conduwuit_admin::AdminCommand;
use serde_json::{Value, json};

fn main() {
	let tree: Vec<Value> = AdminCommand::command()
		.get_subcommands()
		.filter(|command| !command.is_hide_set())
		.map(node)
		.collect();
	println!("{}", serde_json::to_string(&tree).expect("tree serializes"));
}

fn node(command: &Command) -> Value {
	let mut value = json!({
		"name": command.get_name(),
		"description": command.get_about().map(|about| about.to_string()).unwrap_or_default(),
	});
	if command.has_subcommands() {
		value["children"] = command
			.get_subcommands()
			.filter(|sub| !sub.is_hide_set())
			.map(node)
			.collect();
	} else {
		value["aliases"] = command.get_visible_aliases().collect();
		value["parameters"] = command
			.get_arguments()
			.filter(|arg| !arg.is_hide_set())
			.filter_map(parameter)
			.collect();
	}
	value
}

fn text(body: &impl ToString) -> Value { json!({ "m.text": [{ "body": body.to_string() }] }) }

fn primitive(parser: &ValueParser) -> Value {
	let id = parser.type_id();
	let is = |type_id: TypeId| id == type_id;
	let primitive = |kind: &str| json!({ "schema_type": "primitive", "type": kind });

	if is(TypeId::of::<ruma::OwnedRoomOrAliasId>()) {
		return json!({
			"schema_type": "union",
			"variants": [primitive("room_id"), primitive("room_alias")],
		});
	}
	let integers = [
		TypeId::of::<u8>(),
		TypeId::of::<u16>(),
		TypeId::of::<u32>(),
		TypeId::of::<u64>(),
		TypeId::of::<usize>(),
		TypeId::of::<i8>(),
		TypeId::of::<i16>(),
		TypeId::of::<i32>(),
		TypeId::of::<i64>(),
		TypeId::of::<isize>(),
	];
	let kind = if is(TypeId::of::<bool>()) {
		"boolean"
	} else if integers.into_iter().any(is) {
		"integer"
	} else if is(TypeId::of::<ruma::OwnedUserId>()) {
		"user_id"
	} else if is(TypeId::of::<ruma::OwnedRoomId>()) {
		"room_id"
	} else if is(TypeId::of::<ruma::OwnedRoomAliasId>()) {
		"room_alias"
	} else if is(TypeId::of::<ruma::OwnedEventId>()) {
		"event_id"
	} else if is(TypeId::of::<ruma::OwnedServerName>()) {
		"server_name"
	} else {
		"string"
	};
	primitive(kind)
}

fn parameter(arg: &Arg) -> Option<Value> {
	let many = arg
		.get_num_args()
		.is_some_and(|range| range.max_values() > 1);
	let schema = match arg.get_action() {
		| ArgAction::Help | ArgAction::HelpShort | ArgAction::HelpLong | ArgAction::Version =>
			return None,
		| ArgAction::SetTrue | ArgAction::SetFalse =>
			json!({ "schema_type": "primitive", "type": "boolean" }),
		| ArgAction::Count => json!({ "schema_type": "primitive", "type": "integer" }),
		| action => {
			let choices = arg.get_possible_values();
			let item = if choices.is_empty() {
				primitive(arg.get_value_parser())
			} else {
				json!({
					"schema_type": "union",
					"variants": choices
						.iter()
						.filter(|choice| !choice.is_hide_set())
						.map(|choice| json!({ "schema_type": "literal", "value": choice.get_name() }))
						.collect::<Vec<_>>(),
				})
			};
			if matches!(action, ArgAction::Append) || many {
				json!({ "schema_type": "array", "items": item })
			} else {
				item
			}
		},
	};

	let mut parameter = json!({ "key": arg.get_id().as_str(), "schema": schema });
	if !arg.is_required_set() {
		parameter["optional"] = json!(true);
	}
	if let Some(help) = arg.get_long_help().or_else(|| arg.get_help()) {
		parameter["description"] = text(&help);
	}
	if let Some(flag) = arg
		.get_long()
		.map(|long| format!("--{long}"))
		.or_else(|| arg.get_short().map(|short| format!("-{short}")))
	{
		parameter["moe.sable.flag"] = json!(flag);
	}
	if let (Some(default), Some(kind)) =
		(arg.get_default_values().first(), parameter["schema"]["type"].as_str())
		&& kind != "boolean"
	{
		let default = default.to_string_lossy();
		parameter["fi.mau.default_value"] = match kind {
			| "integer" => default
				.parse::<i64>()
				.map_or_else(|_| json!(default), |n| json!(n)),
			| _ => json!(default),
		};
	}
	Some(parameter)
}
