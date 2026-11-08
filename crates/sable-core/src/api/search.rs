use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::Handler;
use crate::search::MAX_SEARCH_RESULTS;
use crate::protocol::{
    RpcError, SearchCoverageView, SearchFilter, SearchHitView, SearchMetricsView,
};
use crate::{Core, view};

const MAX_SEARCH_CONTEXT: usize = 3;

domain! {
    messages,
    coverage,
    metrics,
    peer_start,
    peer_find,
    peer_reset,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PeerStartParams {}

impl Handler for PeerStartParams {
    type Ok = ();
    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.start_search_peers().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PeerFindParams {}

impl Handler for PeerFindParams {
    type Ok = ();
    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.find_search_peers().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PeerResetParams {}

impl Handler for PeerResetParams {
    type Ok = ();
    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let client = core.client().await?;
        core.forget_search_sharing(&client).await;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum SearchOrder {
    #[default]
    Rank,
    Recent,
    Oldest,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MessagesParams {
    pub query: String,
    #[serde(default)]
    pub filter: SearchFilter,
    #[serde(default)]
    pub order: SearchOrder,
    pub limit: u32,
    pub offset: u32,
    #[serde(default)]
    pub context: u32,
    #[serde(default)]
    pub older: Option<String>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MessagesOk {
    pub hits: Vec<SearchHitView>,
    pub older: Option<String>,
}

impl Handler for MessagesParams {
    type Ok = MessagesOk;

    async fn run(self, core: &Arc<Core>) -> Result<MessagesOk, RpcError> {
        let Self {
            query,
            filter,
            order,
            limit,
            offset,
            context,
            older,
        } = self;
        let filter = crate::search::IndexFilter::try_from(filter)?;
        core.prepare_search_query(&query).await?;
        let limit = (limit as usize).min(MAX_SEARCH_RESULTS);
        let context = (context as usize).min(MAX_SEARCH_CONTEXT);
        let (hits, older) = if let Some(cursor) = older {
            core.search_older(&query, &filter, order, limit, &cursor, context)
                .await
        } else {
            let hits = core
                .search_messages(&query, &filter, order, limit, offset as usize, context)
                .await;
            let older = if core.searches_locally(&query, &filter, order).await {
                core.older_start(&filter).await
            } else {
                None
            };
            (hits, older)
        };

        Ok(MessagesOk {
            hits: hits.into_iter().map(view::search_hit_view).collect(),
            older,
        })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CoverageParams {}

impl Handler for CoverageParams {
    type Ok = SearchCoverageView;

    async fn run(self, core: &Arc<Core>) -> Result<SearchCoverageView, RpcError> {
        Ok(core.search_coverage(&core.client().await?).await)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MetricsParams {}

impl Handler for MetricsParams {
    type Ok = SearchMetricsView;

    async fn run(self, core: &Arc<Core>) -> Result<SearchMetricsView, RpcError> {
        Ok(core.search_metrics(&core.client().await?).await)
    }
}
