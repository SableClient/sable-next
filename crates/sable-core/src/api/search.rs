
use serde::{Deserialize, Serialize};

use super::SessionHandler;
use crate::search::MAX_SEARCH_RESULTS;
use crate::protocol::{
    RpcError, SearchCoverageView, SearchFilter, SearchHitView, SearchMetricsView,
};
use crate::{view, SignedIn};

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

impl SessionHandler for PeerStartParams {
    type Ok = ();
    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.start_search_peers().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PeerFindParams {}

impl SessionHandler for PeerFindParams {
    type Ok = ();
    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.find_search_peers().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PeerResetParams {}

impl SessionHandler for PeerResetParams {
    type Ok = ();
    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.forget_search_sharing().await;
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
    /// The query's words as the platform's word segmenter cut them, which is
    /// where Chinese and Japanese are split. Without them each unspaced run is
    /// one word.
    #[serde(default)]
    pub words: Vec<String>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MessagesOk {
    pub hits: Vec<SearchHitView>,
}

impl SessionHandler for MessagesParams {
    type Ok = MessagesOk;
    const ENDS_WITH_SESSION: bool = true;

    async fn run(self, session: &SignedIn) -> Result<MessagesOk, RpcError> {
        let Self {
            query,
            filter,
            order,
            limit,
            offset,
            context,
            words,
        } = self;
        let filter = crate::search::IndexFilter {
            words,
            ..crate::search::IndexFilter::try_from(filter)?
        };
        let limit = (limit as usize).min(MAX_SEARCH_RESULTS);
        let context = (context as usize).min(MAX_SEARCH_CONTEXT);
        let hits = session
            .search_messages(&query, &filter, order, limit, offset as usize, context)
            .await;

        let expand = crate::search::expands(order);
        Ok(MessagesOk {
            hits: hits
                .into_iter()
                .map(|hit| {
                    let matched = sable_search::matching::matched_words(
                        &query,
                        &filter.words,
                        &hit.body,
                        expand,
                    )
                    .unwrap_or_default();
                    view::search_hit_view(hit, matched)
                })
                .collect(),
        })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CoverageParams {}

impl SessionHandler for CoverageParams {
    type Ok = SearchCoverageView;

    async fn run(self, session: &SignedIn) -> Result<SearchCoverageView, RpcError> {
        Ok(session.search_coverage().await)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MetricsParams {}

impl SessionHandler for MetricsParams {
    type Ok = SearchMetricsView;

    async fn run(self, session: &SignedIn) -> Result<SearchMetricsView, RpcError> {
        Ok(session.search_metrics().await)
    }
}
