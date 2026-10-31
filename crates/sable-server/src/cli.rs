use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};

use argon2::{Argon2, Params, PasswordHasher, Version};
use clap::{Parser, Subcommand};

use crate::config::Config;
use crate::lock_instance;
use crate::users::UserRegistry;

type CliResult = Result<(), Box<dyn std::error::Error + Send + Sync>>;

#[derive(Parser)]
#[command(name = "sable-server")]
pub(super) struct Cli {
    #[command(subcommand)]
    pub(super) command: Option<Command>,
    #[arg(long)]
    pub(super) config: Option<PathBuf>,
}

#[derive(Subcommand)]
pub(super) enum Command {
    HashPassword,
    AddUser {
        username: String,
    },
    AddOidcUser {
        subject: String,
    },
    DisableUser {
        id: String,
    },
    RemoveUser {
        id: String,
        #[arg(long)]
        delete_data: bool,
    },
    EnableUser {
        id: String,
    },
    SetUserPassword {
        id: String,
    },
    ListUsers,
}

impl Command {
    pub(super) fn run(self, config: Option<PathBuf>) -> CliResult {
        if matches!(self, Self::HashPassword) {
            println!("{}", hash_password(&read_password_input()?)?);
            return Ok(());
        }
        let config = Config::load(config)?;
        let registry = config.data_dir.join("users.json");
        match self {
            Self::HashPassword => Ok(()),
            Self::AddUser { username } => {
                if username == config.username {
                    return Err("username is reserved for the existing account".into());
                }
                let hash = hash_password(&prompt_new_password()?)?;
                let id = UserRegistry::add_local(&registry, &username, &hash)?;
                println!("Created user {username} ({id}).");
                Ok(())
            }
            Self::AddOidcUser { subject } => {
                let issuer = config
                    .oidc_issuer
                    .as_deref()
                    .ok_or("OIDC issuer is not configured")?;
                let id = UserRegistry::add_oidc(&registry, issuer, &subject)?;
                println!("Created OIDC user {id}.");
                Ok(())
            }
            Self::DisableUser { id } => {
                UserRegistry::set_disabled(&registry, &id, true)?;
                println!("Disabled user {id}.");
                Ok(())
            }
            Self::EnableUser { id } => {
                UserRegistry::set_disabled(&registry, &id, false)?;
                println!("Enabled user {id}.");
                Ok(())
            }
            Self::SetUserPassword { id } => {
                let hash = hash_password(&prompt_new_password()?)?;
                UserRegistry::set_password(&registry, &id, hash)?;
                println!("Updated password for user {id}.");
                Ok(())
            }
            Self::ListUsers => {
                for user in UserRegistry::load(&registry)?.users {
                    println!(
                        "{}\t{}\t{}",
                        user.id,
                        user.username.as_deref().unwrap_or("OIDC"),
                        if user.disabled { "disabled" } else { "enabled" }
                    );
                }
                Ok(())
            }
            Self::RemoveUser { id, delete_data } => remove_user(&config.data_dir, &id, delete_data),
        }
    }
}

fn remove_user(data_dir: &Path, id: &str, delete_data: bool) -> CliResult {
    let uuid = uuid::Uuid::parse_str(id)?;
    if uuid.to_string() != id {
        return Err("user ID must be a canonical UUID".into());
    }
    let _lock = lock_instance(data_dir)?;
    UserRegistry::mark_deleted(&data_dir.join("users.json"), id)?;
    if delete_data {
        match std::fs::remove_dir_all(data_dir.join("users").join(id)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    println!("Removed user {id}.");
    Ok(())
}

fn read_password_input() -> std::io::Result<String> {
    if std::io::stdin().is_terminal() {
        return rpassword::prompt_password("Password: ");
    }
    let mut password = String::new();
    std::io::stdin().read_to_string(&mut password)?;
    Ok(password.trim_end().to_owned())
}

fn prompt_new_password() -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let password = rpassword::prompt_password("Password: ")?;
    if password.is_empty() {
        return Err("password cannot be empty".into());
    }
    Ok(password)
}

fn hash_password(password: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let argon2 = Argon2::new(
        argon2::Algorithm::Argon2id,
        Version::V0x13,
        Params::new(19_456, 2, 1, None)?,
    );
    Ok(argon2.hash_password(password.as_bytes())?.to_string())
}
