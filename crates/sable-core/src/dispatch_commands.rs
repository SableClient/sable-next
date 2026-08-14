macro_rules! dispatch_commands {
    ($self:ident, $command:expr) => {
        match $command {
            Command::DiscoverHomeserver { server_name } => {
                let client = session::discovery_client(&server_name)
                    .await
                    .map_err(|_| CommandErr::UnknownHomeserver)?;

                Ok(CommandOk::DiscoverHomeserver {
                    homeserver: client.homeserver().to_string(),
                })
            }

            Command::Login {
                homeserver,
                username,
                password,
            } => $self.login(homeserver, username, password).await,

            Command::LoginFlows { homeserver } => $self.login_flows(homeserver).await,

            Command::RegistrationFlows { homeserver } => {
                $self.discover_registration_flows(homeserver).await
            }

            Command::Register {
                homeserver,
                username,
                password,
                registration_email,
                registration_token,
            } => {
                $self
                    .register(
                        homeserver,
                        username,
                        password,
                        registration_email,
                        registration_token,
                    )
                    .await
            }

            Command::RequestRegistrationEmail { email } => {
                $self.request_registration_email(email).await
            }

            Command::SubmitRegistrationEmail { token } => {
                $self.submit_registration_email(token).await
            }

            Command::ContinueRegistration => $self.continue_registration(true).await,

            Command::CancelRegistration => {
                $self
                    .next_registration_attempt
                    .fetch_add(1, Ordering::AcqRel);
                $self.pending_registration.lock().await.take();
                $self.pending_login.lock().await.take();
                Ok(CommandOk::CancelRegistration)
            }

            Command::StartOidcLogin {
                homeserver,
                redirect_uri,
                intent,
            } => {
                $self
                    .start_oidc_login(homeserver, redirect_uri, intent)
                    .await
            }

            Command::CompleteOidcLogin { callback_url } => {
                $self.complete_oidc_login(callback_url).await
            }

            Command::StartSsoLogin {
                homeserver,
                redirect_uri,
                idp_id,
                intent,
            } => {
                $self
                    .start_sso_login(homeserver, redirect_uri, idp_id, intent)
                    .await
            }

            Command::CompleteSsoLogin { callback_url } => {
                $self.complete_sso_login(callback_url).await
            }

            Command::Restore => $self.restore().await,

            Command::ListAccounts => $self.list_accounts().await,

            Command::SwitchAccount { account_id } => $self.switch_account(account_id).await,

            Command::Logout => $self.logout().await,

            Command::SubscribeRoomList => $self.subscribe_room_list().await,

            Command::SubscribeTimeline { room_id, event_id } => {
                $self.subscribe_timeline(room_id, event_id).await
            }

            Command::Unsubscribe { subscription } => {
                let _update = $self.room_subscription_lock.lock().await;
                let Some(removed) = $self.subscriptions.lock().await.remove(&subscription) else {
                    return Err(CommandErr::UnknownSubscription);
                };
                let was_live_timeline = matches!(removed.kind, SubscriptionKind::LiveTimeline(_));
                for task in removed.tasks {
                    task.abort();
                }

                if was_live_timeline {
                    $self.sync_timeline_rooms_locked(None).await?;
                }

                Ok(CommandOk::Unsubscribe)
            }

            Command::Paginate {
                subscription,
                direction,
                count,
            } => {
                let (timeline, focused) = $self
                    .subscriptions
                    .lock()
                    .await
                    .get(&subscription)
                    .and_then(|subscription| {
                        subscription.timeline.clone().map(|timeline| {
                            (
                                timeline,
                                matches!(subscription.kind, SubscriptionKind::FocusedTimeline),
                            )
                        })
                    })
                    .ok_or(CommandErr::UnknownSubscription)?;
                if matches!(direction, PaginationDirection::Forward) && !focused {
                    return Err(CommandErr::InvalidPaginationDirection);
                }
                let reached_end = match direction {
                    PaginationDirection::Backward => timeline.paginate_backwards(count).await,
                    PaginationDirection::Forward => timeline.paginate_forwards(count).await,
                }
                .map_err(|error| $self.failed("paginate", error))?;

                Ok(CommandOk::Paginate {
                    direction,
                    reached_end,
                })
            }

            Command::SendMessage {
                room_id,
                body,
                formatted,
                in_reply_to,
            } => {
                let timeline = $self.timeline(&room_id).await?;
                let content = message_content(body, formatted);

                match in_reply_to {
                    // `send_reply` fills the thread relation itself.
                    Some(event_id) => timeline
                        .send_reply(content.into(), event_id)
                        .await
                        .map_err(|error| $self.failed("send_reply", error))?,
                    None => {
                        timeline
                            .send(content.into())
                            .await
                            .map_err(|error| $self.failed("send_message", error))?;
                    }
                }

                Ok(CommandOk::SendMessage)
            }

            Command::EditMessage {
                room_id,
                event_id,
                body,
                formatted,
            } => {
                $self
                    .timeline(&room_id)
                    .await?
                    .edit(
                        &TimelineEventItemId::EventId(event_id),
                        EditedContent::RoomMessage(message_content(body, formatted).into()),
                    )
                    .await
                    .map_err(|error| $self.failed("edit_message", error))?;

                Ok(CommandOk::EditMessage)
            }

            Command::FetchEventDetails { room_id, event_id } => {
                $self
                    .timeline(&room_id)
                    .await?
                    .fetch_details_for_event(&event_id)
                    .await
                    .map_err(|error| $self.failed("fetch_event_details", error))?;

                Ok(CommandOk::FetchEventDetails)
            }

            Command::RoomMembers { room_id } => {
                let room = $self.room(&room_id).await?;
                let members = room
                    .members(RoomMemberships::JOIN)
                    .await
                    .map_err(|error| $self.failed("room_members", error))?;

                Ok(CommandOk::RoomMembers {
                    members: members.iter().map(view::member_view).collect(),
                })
            }

            Command::UserProfile { user_id } => {
                let response = $self
                    .client()
                    .await?
                    .account()
                    .fetch_user_profile_of(&user_id)
                    .await
                    .map_err(|error| $self.failed("user_profile", error))?;

                Ok(CommandOk::UserProfile {
                    profile: ProfileView {
                        user_id,
                        display_name: response.get_static::<DisplayName>().ok().flatten(),
                        avatar_url: response
                            .get_static::<AvatarUrl>()
                            .ok()
                            .flatten()
                            .map(|url| url.to_string()),
                        bio: profile_bio(&response),
                        hero_color: profile_hero_color(&response),
                    },
                })
            }

            Command::Redact {
                room_id,
                event_id,
                reason,
            } => {
                $self
                    .timeline(&room_id)
                    .await?
                    .redact(&TimelineEventItemId::EventId(event_id), reason.as_deref())
                    .await
                    .map_err(|error| $self.failed("redact", error))?;

                Ok(CommandOk::Redact)
            }

            Command::React {
                room_id,
                event_id,
                key,
            } => {
                $self
                    .timeline(&room_id)
                    .await?
                    .toggle_reaction(&TimelineEventItemId::EventId(event_id), &key)
                    .await
                    .map_err(|error| $self.failed("react", error))?;

                Ok(CommandOk::React)
            }

            Command::EncryptionStatus => Ok(CommandOk::EncryptionStatus {
                status: encryption_status(&$self.client().await?).await,
            }),

            Command::Devices => {
                let client = $self.client().await?;
                let own_device_id = client.device_id().map(ToOwned::to_owned);
                let account_management = client.oauth().full_session().is_some()
                    && client
                        .oauth()
                        .server_metadata()
                        .await
                        .ok()
                        .and_then(|metadata| metadata.account_management_uri)
                        .is_some();

                let user_id = client.user_id().ok_or(CommandErr::NotLoggedIn)?.to_owned();
                let devices = client
                    .encryption()
                    .get_user_devices(&user_id)
                    .await
                    .map_err(|error| $self.failed("devices", error))?;

                Ok(CommandOk::Devices {
                    devices: devices
                        .devices()
                        .map(|device| protocol::DeviceView {
                            is_own: Some(device.device_id()) == own_device_id.as_deref(),
                            device_id: device.device_id().to_owned(),
                            display_name: device.display_name().map(str::to_owned),
                            is_verified: device.is_verified(),
                        })
                        .collect(),
                    account_management,
                })
            }

            Command::RecoverIdentity { recovery_key } => {
                $self
                    .client()
                    .await?
                    .encryption()
                    .recovery()
                    .recover(&recovery_key)
                    .await
                    .map_err(|error| $self.recovery_error(error))?;

                Ok(CommandOk::RecoverIdentity)
            }

            Command::EnableRecovery { passphrase } => {
                let client = $self.client().await?;
                let recovery = client.encryption().recovery();
                let enable = recovery.enable();

                let recovery_key = match &passphrase {
                    Some(passphrase) => enable.with_passphrase(passphrase).await,
                    None => enable.await,
                }
                .map_err(|error| $self.failed("enable_recovery", error))?;

                Ok(CommandOk::EnableRecovery { recovery_key })
            }

            Command::ResetRecoveryKey { passphrase } => {
                let client = $self.client().await?;
                let recovery = client.encryption().recovery();
                let reset = recovery.reset_key();

                let recovery_key = match &passphrase {
                    Some(passphrase) => reset.with_passphrase(passphrase).await,
                    None => reset.await,
                }
                .map_err(|error| $self.failed("reset_recovery_key", error))?;

                Ok(CommandOk::ResetRecoveryKey { recovery_key })
            }

            Command::DeleteDevice {
                device_id,
                password,
            } => {
                let client = $self.client().await?;
                let devices = [device_id];

                if client.oauth().full_session().is_some()
                    && let Ok(metadata) = client.oauth().server_metadata().await
                    && let Some(url) = metadata.account_management_url_with_action(
                        matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::AccountManagementActionData::DeviceDelete(
                            matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::DeviceDeleteData::new(devices[0].as_ref()),
                        ),
                    )
                {
                    return Ok(CommandOk::DeleteDevice {
                        management_url: Some(url.to_string()),
                    });
                }

                // The flows cannot be asked for up front.
                let Err(error) = client.delete_devices(&devices, None).await else {
                    return Ok(CommandOk::DeleteDevice {
                        management_url: None,
                    });
                };

                let Some(uiaa) = error.as_uiaa_response() else {
                    return Err($self.failed("delete_device", error));
                };

                // Recaptcha, SSO and terms need the server's fallback page.
                let password_only = uiaa
                    .flows
                    .iter()
                    .any(|flow| flow.stages == [AuthType::Password]);

                let password = match password {
                    Some(password) if password_only => password,
                    _ => {
                        return Err(CommandErr::InteractiveAuthRequired {
                            stages: uiaa
                                .flows
                                .iter()
                                .flat_map(|flow| &flow.stages)
                                .map(|stage| stage.as_str().to_owned())
                                .collect(),
                        });
                    }
                };

                let user_id = client.user_id().ok_or(CommandErr::NotLoggedIn)?.to_owned();
                let mut auth = Password::new(UserIdentifier::Matrix(user_id.into()), password);
                // Without the session id this starts a new flow.
                auth.session = uiaa.session.clone();

                client
                    .delete_devices(&devices, Some(AuthData::Password(auth)))
                    .await
                    .map_err(|error| match error.as_uiaa_response() {
                        // A wrong password comes back as another challenge.
                        Some(_) => CommandErr::Denied,
                        None => $self.failed("delete_device: auth", error),
                    })?;

                Ok(CommandOk::DeleteDevice {
                    management_url: None,
                })
            }

            Command::RenameDevice {
                device_id,
                display_name,
            } => {
                $self
                    .client()
                    .await?
                    .rename_device(&device_id, &display_name)
                    .await
                    .map_err(|error| $self.failed("rename_device", error))?;

                Ok(CommandOk::RenameDevice)
            }

            Command::SetDisplayName { name } => {
                $self
                    .client()
                    .await?
                    .account()
                    .set_display_name(name.as_deref())
                    .await
                    .map_err(|error| $self.failed("set_display_name", error))?;

                Ok(CommandOk::SetDisplayName)
            }

            Command::SetAvatarUrl { url } => {
                let url = match url {
                    Some(url) => Some(mxc_uri(&url)?),
                    None => None,
                };

                $self
                    .client()
                    .await?
                    .account()
                    .set_avatar_url(url.as_deref())
                    .await
                    .map_err(|error| $self.failed("set_avatar_url", error))?;

                Ok(CommandOk::SetAvatarUrl)
            }

            Command::IgnoreUser { user_id } => {
                $self
                    .client()
                    .await?
                    .account()
                    .ignore_user(&user_id)
                    .await
                    .map_err(|error| $self.failed("ignore_user", error))?;

                Ok(CommandOk::IgnoreUser)
            }

            Command::UnignoreUser { user_id } => {
                $self
                    .client()
                    .await?
                    .account()
                    .unignore_user(&user_id)
                    .await
                    .map_err(|error| $self.failed("unignore_user", error))?;

                Ok(CommandOk::UnignoreUser)
            }

            Command::SetTyping { room_id, typing } => {
                $self
                    .room(&room_id)
                    .await?
                    .typing_notice(typing)
                    .await
                    .map_err(|error| $self.failed("set_typing", error))?;

                Ok(CommandOk::SetTyping)
            }

            Command::SetRoomTag { room_id, tag, set } => {
                let room = $self.room(&room_id).await?;
                let name = match tag {
                    RoomTag::Favourite => TagName::Favorite,
                    RoomTag::LowPriority => TagName::LowPriority,
                };

                if set {
                    room.set_tag(name, TagInfo::new())
                        .await
                        .map_err(|error| $self.failed("set_room_tag", error))?;
                } else {
                    room.remove_tag(name)
                        .await
                        .map_err(|error| $self.failed("remove_room_tag", error))?;
                }

                Ok(CommandOk::SetRoomTag)
            }

            Command::SetDirect { room_id, direct } => {
                let client = $self.client().await?;
                let room = $self.room(&room_id).await?;

                if direct {
                    // `m.direct` is keyed by the other user, not by the room.
                    let members = room
                        .members(RoomMemberships::ACTIVE)
                        .await
                        .map_err(|error| $self.failed("set_direct: members", error))?;

                    let others: Vec<OwnedUserId> = members
                        .iter()
                        .map(|member| member.user_id().to_owned())
                        .filter(|user_id| Some(user_id.as_ref()) != client.user_id())
                        .collect();

                    client
                        .account()
                        .mark_as_dm(&room_id, &others)
                        .await
                        .map_err(|error| $self.failed("set_direct", error))?;
                } else {
                    room.set_is_direct(false)
                        .await
                        .map_err(|error| $self.failed("unset_direct", error))?;
                }

                Ok(CommandOk::SetDirect)
            }

            Command::SetRoomJoinRule { room_id, rule } => {
                let rule = match rule {
                    JoinRuleView::Public => JoinRule::Public,
                    JoinRuleView::Invite => JoinRule::Invite,
                    JoinRuleView::Knock => JoinRule::Knock,
                };

                $self
                    .room(&room_id)
                    .await?
                    .send_state_event(RoomJoinRulesEventContent::new(rule))
                    .await
                    .map_err(|error| $self.failed("set_room_join_rule", error))?;

                Ok(CommandOk::SetRoomJoinRule)
            }

            Command::SendStateEvent {
                room_id,
                event_type,
                state_key,
                content,
            } => {
                $self
                    .room(&room_id)
                    .await?
                    .send_state_event_raw(&event_type, &state_key, &content)
                    .await
                    .map_err(|error| $self.failed("send_state_event", error))?;

                Ok(CommandOk::SendStateEvent)
            }

            Command::SetRoomName { room_id, name } => {
                // The spec clears a name with an empty one.
                $self
                    .room(&room_id)
                    .await?
                    .set_name(name.unwrap_or_default())
                    .await
                    .map_err(|error| $self.failed("set_room_name", error))?;

                Ok(CommandOk::SetRoomName)
            }

            Command::SetRoomTopic { room_id, topic } => {
                $self
                    .room(&room_id)
                    .await?
                    .set_room_topic(&topic)
                    .await
                    .map_err(|error| $self.failed("set_room_topic", error))?;

                Ok(CommandOk::SetRoomTopic)
            }

            Command::SetRoomAvatar { room_id, url } => {
                let room = $self.room(&room_id).await?;

                match url {
                    Some(url) => {
                        room.set_avatar_url(&mxc_uri(&url)?, None)
                            .await
                            .map_err(|error| $self.failed("set_room_avatar", error))?;
                    }
                    // State cannot be deleted, so empty content is the removal.
                    None => {
                        room.send_state_event(RoomAvatarEventContent::new())
                            .await
                            .map_err(|error| $self.failed("clear_room_avatar", error))?;
                    }
                }

                Ok(CommandOk::SetRoomAvatar)
            }

            Command::SetUserPowerLevel {
                room_id,
                user_id,
                power_level,
            } => {
                $self
                    .room(&room_id)
                    .await?
                    .update_power_levels(vec![(&user_id, power_level.into())])
                    .await
                    .map_err(|error| $self.failed("set_user_power_level", error))?;

                Ok(CommandOk::SetUserPowerLevel)
            }

            Command::KickUser {
                room_id,
                user_id,
                reason,
            } => {
                $self
                    .room(&room_id)
                    .await?
                    .kick_user(&user_id, reason.as_deref())
                    .await
                    .map_err(|error| $self.failed("kick_user", error))?;

                Ok(CommandOk::KickUser)
            }

            Command::BanUser {
                room_id,
                user_id,
                reason,
            } => {
                $self
                    .room(&room_id)
                    .await?
                    .ban_user(&user_id, reason.as_deref())
                    .await
                    .map_err(|error| $self.failed("ban_user", error))?;

                Ok(CommandOk::BanUser)
            }

            Command::UnbanUser {
                room_id,
                user_id,
                reason,
            } => {
                $self
                    .room(&room_id)
                    .await?
                    .unban_user(&user_id, reason.as_deref())
                    .await
                    .map_err(|error| $self.failed("unban_user", error))?;

                Ok(CommandOk::UnbanUser)
            }

            Command::RequestVerification { user_id } => {
                let request = $self
                    .client()
                    .await?
                    .encryption()
                    .get_user_identity(&user_id)
                    .await
                    .map_err(|error| $self.failed("request_verification: identity", error))?
                    // No cross-signing identity: keys not downloaded, or none set.
                    .ok_or(CommandErr::Unavailable)?
                    .request_verification()
                    .await
                    .map_err(|error| $self.failed("request_verification", error))?;

                let flow_id = request.flow_id().to_owned();
                $self.watch_verification(request);

                Ok(CommandOk::RequestVerification { flow_id })
            }

            Command::AcceptVerification { user_id, flow_id } => {
                let request = $self.verification_request(&user_id, &flow_id).await?;

                request
                    .accept()
                    .await
                    .map_err(|error| $self.failed("accept_verification", error))?;

                Ok(CommandOk::AcceptVerification)
            }

            Command::ConfirmVerification { user_id, flow_id } => {
                $self
                    .sas(&user_id, &flow_id)
                    .await?
                    .confirm()
                    .await
                    .map_err(|error| $self.failed("confirm_verification", error))?;

                Ok(CommandOk::ConfirmVerification)
            }

            Command::CancelVerification {
                user_id,
                flow_id,
                mismatch,
            } => {
                // No SAS to report a mismatch on before the emoji show.
                match $self.sas(&user_id, &flow_id).await {
                    Ok(sas) if mismatch => sas
                        .mismatch()
                        .await
                        .map_err(|error| $self.failed("cancel_verification: mismatch", error))?,
                    Ok(sas) => sas
                        .cancel()
                        .await
                        .map_err(|error| $self.failed("cancel_verification: sas", error))?,
                    Err(_) => $self
                        .verification_request(&user_id, &flow_id)
                        .await?
                        .cancel()
                        .await
                        .map_err(|error| $self.failed("cancel_verification", error))?,
                }

                Ok(CommandOk::CancelVerification)
            }

            Command::CreateRoom {
                name,
                topic,
                is_space,
                public,
                encrypted,
                invite,
                parent_space,
            } => {
                let client = $self.client().await?;
                let mut request = create_room::v3::Request::new();
                request.name = name;
                request.topic = topic;
                request.invite = invite;
                request.visibility = if public {
                    Visibility::Public
                } else {
                    Visibility::Private
                };
                request.preset = Some(if public {
                    RoomPreset::PublicChat
                } else {
                    RoomPreset::PrivateChat
                });

                if is_space {
                    let mut creation = RoomCreateEventContent::new_v11();
                    creation.room_type = Some(RoomType::Space);
                    request.creation_content = Some(
                        Raw::new(&creation)
                            .map_err(|error| $self.failed("create_room: space type", error))?
                            .cast_unchecked(),
                    );
                } else if encrypted && !public {
                    // Anyone can join and read, so encryption only breaks previews.
                    request.initial_state = vec![InitialStateEvent::with_empty_state_key(
                        RoomEncryptionEventContent::with_recommended_defaults(),
                    )
                    .to_raw_any()];
                }

                let room = client
                    .create_room(request)
                    .await
                    .map_err(|error| $self.failed("create_room", error))?;

                if let Some(space_id) = parent_space {
                    $self.add_to_space(&space_id, room.room_id()).await?;
                }

                Ok(CommandOk::CreateRoom {
                    room_id: room.room_id().to_owned(),
                })
            }

            Command::CreateDm { user_id } => {
                let room = $self
                    .client()
                    .await?
                    .create_dm(&user_id)
                    .await
                    .map_err(|error| $self.failed("create_dm", error))?;

                Ok(CommandOk::CreateDm {
                    room_id: room.room_id().to_owned(),
                })
            }

            Command::AddToSpace { space_id, room_id } => {
                $self.add_to_space(&space_id, &room_id).await?;

                Ok(CommandOk::AddToSpace)
            }

            Command::RemoveFromSpace { space_id, room_id } => {
                // The spec delists by omitting `via`. The typed content has it
                // non-optional and would send `{"via": []}`, a valid array.
                $self
                    .room(&space_id)
                    .await?
                    .send_state_event_raw("m.space.child", room_id.as_str(), &serde_json::json!({}))
                    .await
                    .map_err(|error| $self.failed("remove_from_space", error))?;

                Ok(CommandOk::RemoveFromSpace)
            }

            Command::JoinRoom { address, via } => {
                let address =
                    RoomOrAliasId::parse(&address).map_err(|_| CommandErr::UnknownRoom)?;

                let via = via
                    .iter()
                    .filter_map(|server| ServerName::parse(server).ok())
                    .collect::<Vec<_>>();

                let room = $self
                    .client()
                    .await?
                    .join_room_by_id_or_alias(&address, &via)
                    .await
                    .map_err(|error| $self.failed("join_room", error))?;

                Ok(CommandOk::JoinRoom {
                    room_id: room.room_id().to_owned(),
                })
            }

            Command::LeaveRoom { room_id } => {
                $self
                    .room(&room_id)
                    .await?
                    .leave()
                    .await
                    .map_err(|error| $self.failed("leave_room", error))?;

                // Keeping it would hand a stale timeline back on rejoin.
                $self.timelines.lock().await.remove(&room_id);

                Ok(CommandOk::LeaveRoom)
            }

            Command::InviteUser { room_id, user_id } => {
                $self
                    .room(&room_id)
                    .await?
                    .invite_user_by_id(&user_id)
                    .await
                    .map_err(|error| $self.failed("invite_user", error))?;

                Ok(CommandOk::InviteUser)
            }

            Command::MarkRead { room_id, event_id } => {
                // The server drops it unless newer, so the UI may send freely.
                $self
                    .timeline(&room_id)
                    .await?
                    .send_single_receipt(ReceiptType::Read, event_id)
                    .await
                    .map_err(|error| $self.failed("mark_read", error))?;

                Ok(CommandOk::MarkRead)
            }

            Command::RetrySend {
                room_id,
                transaction_id,
            } => {
                $self
                    .local_echo(&room_id, &transaction_id)
                    .await?
                    .unwedge()
                    .await
                    .map_err(|error| $self.failed("retry_send", error))?;

                Ok(CommandOk::RetrySend)
            }

            Command::CancelSend {
                room_id,
                transaction_id,
            } => {
                let cancelled = $self
                    .local_echo(&room_id, &transaction_id)
                    .await?
                    .abort()
                    .await
                    .map_err(|error| $self.failed("cancel_send", error))?;

                Ok(CommandOk::CancelSend { cancelled })
            }
        }
    };
}
