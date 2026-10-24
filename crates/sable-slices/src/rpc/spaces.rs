use sable_model::sidebar::SidebarItemView;
use sable_runtime::Rpc;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct SpaceSidebar {}

impl Rpc for SpaceSidebar {
    const METHOD: &'static str = "spaces.sidebar";
    type Ok = Vec<SidebarItemView>;
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SetSpaceSidebar {
    pub items: Vec<SidebarItemView>,
}

impl Rpc for SetSpaceSidebar {
    const METHOD: &'static str = "spaces.set_sidebar";
    type Ok = ();
}
