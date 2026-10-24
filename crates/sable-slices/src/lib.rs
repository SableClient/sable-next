#![expect(
    clippy::missing_errors_doc,
    reason = "registration errors are represented by the return type"
)]

mod backoff;
pub mod rooms;
pub mod rpc;
pub mod sidebar;
pub mod timeline;

use sable_runtime::{DuplicateSlice, Lifetime, Registry, Rpc};
use std::time::Duration;

const KEPT: Lifetime = Lifetime::RefCounted {
    grace: Duration::from_secs(10),
};

pub const CORE_METHODS: [&str; 9] = [
    rpc::timeline::SubscribeRoomList::METHOD,
    rpc::timeline::Unsubscribe::METHOD,
    rpc::timeline::WarmRooms::METHOD,
    rpc::spaces::SpaceSidebar::METHOD,
    rpc::spaces::SetSpaceSidebar::METHOD,
    rpc::timeline::Subscribe::METHOD,
    rpc::timeline::Paginate::METHOD,
    rpc::timeline::ReadMarker::METHOD,
    rpc::timeline::FetchEventDetails::METHOD,
];

pub fn register(mut registry: Registry) -> Result<Registry, DuplicateSlice> {
    registry.add::<rooms::Rooms>()?;
    registry.add::<sidebar::Sidebar>()?;
    registry.add::<timeline::Timeline>()?;
    Ok(registry)
}
