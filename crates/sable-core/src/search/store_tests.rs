use matrix_sdk::ruma::{OwnedRoomId, RoomId, room_id};

use std::sync::Arc;

use super::{DATABASE, Location, Store, open_connection, open_or_start_over, search_key};
use crate::api::search::SearchOrder;
use crate::protocol::SearchAttachment;
use crate::search::exec::{Exec, block_on};
use crate::search::tests::document;
use crate::search::{IndexFilter, MessageIndex};
use crate::secrets::Key;

fn file_store(location: &Location, key: Option<&Key>) -> Result<Store, sable_sql::OpenError> {
    let connection = open_connection(location, key)?;
    Ok(Store::from_exec(Exec::Native(Arc::new(
        parking_lot::Mutex::new(Some(connection)),
    ))))
}

fn room() -> &'static RoomId {
    room_id!("!store:localhost")
}

fn index_of(bodies: &[&str]) -> MessageIndex {
    let index = MessageIndex::new();
    for (position, body) in bodies.iter().enumerate() {
        index.upsert(
            room(),
            document(
                &position.to_string(),
                body,
                "@kris:localhost",
                position as u64,
                None,
                Vec::new(),
            ),
        );
    }
    index
}

fn ranked_words(index: &MessageIndex, query: &str, words: &[&str], order: SearchOrder) -> Vec<u32> {
    let filter = IndexFilter {
        words: words.iter().map(|word| (*word).to_owned()).collect(),
        ..IndexFilter::default()
    };
    index
        .search(query, &filter, order, 50, 0)
        .into_iter()
        .map(|hit| {
            hit.event_id
                .as_str()
                .trim_start_matches('$')
                .parse()
                .unwrap()
        })
        .collect()
}

fn ranked(index: &MessageIndex, query: &str) -> Vec<u32> {
    ranked_words(index, query, &[], SearchOrder::Rank)
}

fn found_unexpanded(index: &MessageIndex, query: &str) -> Vec<u32> {
    let mut found = ranked_words(index, query, &[], SearchOrder::Recent);
    found.sort_unstable();
    found
}

fn key(byte: u8) -> Key {
    Key::new([byte; 32])
}

#[test]
fn the_search_key_differs_from_the_store_key_and_is_stable() {
    let store_key = key(7);
    let search = search_key(&store_key).unwrap();

    assert_ne!(*search, *store_key);
    assert_eq!(*search, *search_key(&store_key).unwrap());
    assert_ne!(*search, *search_key(&key(8)).unwrap());
}

#[test]
fn an_encrypted_database_holds_no_plaintext_and_needs_its_key() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("search.sqlite3");
    let location = Location::File(path.clone());
    {
        let store = file_store(&location, Some(&key(1))).unwrap();
        let index = MessageIndex::with_store(store);
        index.upsert(
            room(),
            document(
                "secret",
                "a hunter2 passphrase nobody should read",
                "@kris:localhost",
                1,
                None,
                Vec::new(),
            ),
        );
    }

    let bytes = std::fs::read(&path).unwrap();
    for needle in ["hunter2", "passphrase", "@kris:localhost", "SQLite format"] {
        assert!(
            !bytes
                .windows(needle.len())
                .any(|window| window == needle.as_bytes()),
            "{needle:?} is readable in the file"
        );
    }
    open_connection(&location, Some(&key(2))).unwrap_err();
    open_connection(&location, None).unwrap_err();

    let reopened = MessageIndex::with_store(file_store(&location, Some(&key(1))).unwrap());
    let hits = reopened.search("hunter2", &IndexFilter::default(), SearchOrder::Rank, 5, 0);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].event_id.as_str(), "$secret");
}

#[test]
fn a_database_of_an_older_schema_is_started_over() {
    let directory = tempfile::tempdir().unwrap();
    {
        let older = rusqlite::Connection::open(directory.path().join(DATABASE)).unwrap();
        older
            .execute_batch("CREATE TABLE doc (id INTEGER PRIMARY KEY); PRAGMA user_version = 1;")
            .unwrap();
    }

    let connection = open_or_start_over(directory.path(), None).unwrap();

    let indexed: i64 = connection
        .query_row("SELECT count(*) FROM fts", [], |row| row.get(0))
        .unwrap();
    assert_eq!(indexed, 0);
}

#[test]
fn a_filter_only_the_document_answers_pages_through_every_match_once() {
    let index = MessageIndex::new();
    for position in 0..700 {
        index.upsert(
            room(),
            document(
                &position.to_string(),
                "deploy notes",
                "@kris:localhost",
                position,
                (position % 2 == 0).then_some(SearchAttachment::Image),
                Vec::new(),
            ),
        );
    }
    let pictures = IndexFilter {
        has: vec![SearchAttachment::Image],
        ..IndexFilter::default()
    };

    let mut found = Vec::new();
    loop {
        let page = index.search("deploy", &pictures, SearchOrder::Oldest, 100, found.len());
        if page.is_empty() {
            break;
        }
        found.extend(page.into_iter().map(|hit| hit.origin_server_ts));
    }

    assert_eq!(found, (0..700).step_by(2).collect::<Vec<u64>>());
}

#[test]
fn words_of_scripts_that_stack_marks_are_told_apart_and_an_emoji_is_found() {
    let index = index_of(&["ດີ ຫຼາຍ", "ດາ ຫຼາຍ", "party 🎉 time"]);

    assert_eq!(found_unexpanded(&index, "ດີ"), [0]);
    assert_eq!(found_unexpanded(&index, "🎉"), [2]);
}

#[test]
fn a_reopened_database_keeps_its_documents_and_their_search_terms() {
    let directory = tempfile::tempdir().unwrap();
    let location = Location::File(directory.path().join("search.sqlite3"));
    {
        let index = MessageIndex::with_store(file_store(&location, None).unwrap());
        index.upsert(
            room(),
            document(
                "1",
                "the deployment pipeline",
                "@kris:localhost",
                1,
                None,
                Vec::new(),
            ),
        );
    }

    let reopened = MessageIndex::with_store(file_store(&location, None).unwrap());

    assert_eq!(ranked(&reopened, "pipeline"), [1]);
}

#[test]
fn thai_text_is_found_by_its_words_inside_a_run() {
    let index = index_of(&["สวัสดีครับทุกคน", "ขอบคุณมาก", "hello world"]);

    assert_eq!(
        ranked_words(&index, "สวัสดี", &["สวัสดี"], SearchOrder::Rank),
        [0]
    );
    assert_eq!(
        ranked_words(&index, "ขอบคุณ", &["ขอบคุณ"], SearchOrder::Recent),
        [1]
    );
    assert_eq!(ranked(&index, "hello"), [2]);
}

#[test]
fn a_misspelled_message_matches_the_correct_word() {
    let index = index_of(&["please deligate this", "nothing here"]);
    assert_eq!(ranked(&index, "delegate"), [0]);
}

#[test]
fn a_misspelled_query_matches_the_correct_word() {
    let index = index_of(&["please delegate this"]);
    assert_eq!(ranked(&index, "deligate"), [0]);
}

#[test]
fn an_exact_match_outranks_a_typo() {
    let index = index_of(&["the deligate came", "the delegate came"]);
    assert_eq!(ranked(&index, "delegate"), [1, 0]);
}

#[test]
fn a_swapped_pair_of_letters_is_one_typo() {
    let index = index_of(&["recieve the file"]);
    assert_eq!(ranked(&index, "receive"), [0]);
}

#[test]
fn short_words_must_match_exactly() {
    let index = index_of(&["the cat sat"]);
    assert_eq!(ranked(&index, "cot"), Vec::<u32>::new());
}

#[test]
fn the_first_letter_must_match() {
    let index = index_of(&["a great delegate"]);
    assert_eq!(ranked(&index, "selegate"), Vec::<u32>::new());
}

#[test]
fn words_with_digits_must_match_exactly() {
    let index = index_of(&["release 20240 ticket1420"]);
    assert_eq!(ranked(&index, "20250"), Vec::<u32>::new());
    assert_eq!(ranked(&index, "ticket1402"), Vec::<u32>::new());
}

#[test]
fn a_prefix_matches_longer_words() {
    let index = index_of(&["deployment pipeline"]);
    assert_eq!(ranked(&index, "dep"), [0]);
}

#[test]
fn every_query_word_adds_to_the_score() {
    let index = index_of(&["deploy failed", "deploy worked"]);
    assert_eq!(ranked(&index, "deploy failed"), [0, 1]);
}

#[test]
fn a_date_order_finds_only_the_word_and_its_inflections() {
    let index = index_of(&["please mute it", "so I muted it", "a tokio mutex"]);
    assert_eq!(found_unexpanded(&index, "mute"), [0, 1]);
    assert_eq!(ranked(&index, "mute").len(), 3);
}

#[test]
fn a_date_order_still_finds_text_written_without_spaces() {
    let index = index_of(&["黒い猫", "検索を使う", "今天我们一起讨论中文搜索功能"]);
    assert_eq!(found_unexpanded(&index, "黒"), [0]);
    assert_eq!(found_unexpanded(&index, "猫"), [0]);
    assert_eq!(found_unexpanded(&index, "検索"), [1]);
    assert_eq!(found_unexpanded(&index, "搜索"), [2]);
    assert_eq!(found_unexpanded(&index, "中"), [2]);
    assert_eq!(found_unexpanded(&index, "搜"), [2]);
}

#[test]
fn a_japanese_word_does_not_match_words_sharing_one_character() {
    let index = index_of(&["検索を使う", "検討します", "索引です"]);
    assert_eq!(
        ranked_words(&index, "検索", &["検索"], SearchOrder::Rank),
        [0]
    );
}

#[test]
fn a_japanese_word_is_found_inside_a_longer_word() {
    let index = index_of(&["東京都庁に行く", "京都に行く"]);
    assert_eq!(
        ranked_words(&index, "東京", &["東京"], SearchOrder::Rank),
        [0]
    );
}

#[test]
fn a_japanese_particle_does_not_weld_the_words_around_it() {
    let index = index_of(&["日本語の検索機能", "英語を勉強する"]);
    assert_eq!(
        ranked_words(
            &index,
            "日本語で検索",
            &["日本語", "で", "検索"],
            SearchOrder::Rank
        ),
        [0]
    );

    let index = index_of(&["検索を使った", "索引です"]);
    assert_eq!(
        ranked_words(
            &index,
            "検索を使う",
            &["検索", "を", "使う"],
            SearchOrder::Rank
        ),
        [0]
    );
}

#[test]
fn a_japanese_word_needs_its_pairs_in_order_and_next_to_each_other() {
    let index = index_of(&["東京都に住む", "京都から東京へ行く"]);
    assert_eq!(
        ranked_words(&index, "東京都", &["東京", "都"], SearchOrder::Rank),
        [0]
    );

    let index = index_of(&["電話番号を教える", "電話と話番号"]);
    assert_eq!(
        ranked_words(&index, "電話番号", &["電話番号"], SearchOrder::Rank),
        [0]
    );
}

#[test]
fn a_japanese_word_does_not_match_text_sharing_only_some_of_its_pairs() {
    let hiragana = index_of(&[
        "ありがとうございます",
        "ありとあらゆる手段",
        "とうとう終わった",
    ]);
    assert_eq!(
        ranked_words(&hiragana, "ありがとう", &["ありがとう"], SearchOrder::Rank),
        [0]
    );

    let katakana = index_of(&["メッセージを送る", "メロンとソーセージ"]);
    assert_eq!(
        ranked_words(&katakana, "メッセージ", &["メッセージ"], SearchOrder::Rank),
        [0]
    );
}

#[test]
fn an_unvoiced_kana_does_not_match_its_voiced_form() {
    let index = index_of(&["か", "が"]);
    assert_eq!(ranked_words(&index, "か", &["か"], SearchOrder::Rank), [0]);
    assert_eq!(ranked_words(&index, "が", &["が"], SearchOrder::Rank), [1]);
}

#[test]
fn separate_chinese_words_in_one_query_each_add_to_the_score() {
    let index = index_of(&["中文搜索功能", "中文消息", "天气"]);
    assert_eq!(
        ranked_words(&index, "中文功能", &["中文", "功能"], SearchOrder::Rank),
        [0, 1]
    );
}

#[test]
fn a_query_split_into_words_finds_a_message_across_a_word_boundary() {
    let index = index_of(&["日本語を勉強する", "日本語の本", "英語"]);
    assert_eq!(
        ranked_words(&index, "日本語勉強", &["日本語", "勉強"], SearchOrder::Rank),
        [0, 1]
    );
}

#[test]
fn a_query_without_words_needs_its_whole_run() {
    let index = index_of(&["日本語を勉強する", "日本語勉強会"]);
    assert_eq!(ranked(&index, "日本語勉強"), [1]);
}

#[test]
fn a_removed_document_stops_matching() {
    let index = index_of(&["delegate", "delegate"]);
    index.remove(room(), matrix_sdk::ruma::event_id!("$0"));

    assert_eq!(ranked(&index, "delegate"), [1]);
    assert_eq!(index.len(), 1);
}

#[test]
fn a_changed_body_replaces_the_terms_it_was_found_by() {
    let index = index_of(&["first draft"]);
    index.upsert(
        room(),
        document("0", "final version", "@kris:localhost", 0, None, Vec::new()),
    );

    assert_eq!(ranked(&index, "draft"), Vec::<u32>::new());
    assert_eq!(ranked(&index, "version"), [0]);
    assert_eq!(index.len(), 1);
}

#[test]
fn the_oldest_documents_go_first_when_the_database_outgrows_its_budget() {
    let index = MessageIndex::new();
    for position in 0..400_u64 {
        index.upsert(
            room(),
            document(
                &format!("d{position}"),
                &format!("deploy note number {position} with some padding text to fill pages"),
                "@kris:localhost",
                1_000 + position,
                None,
                Vec::new(),
            ),
        );
    }
    let full = block_on(index.store().used_bytes()).unwrap();

    let evicted = block_on(index.store().evict_to(full / 2)).unwrap();

    assert_eq!(evicted, [room().to_owned()]);
    let left = index.len();
    assert!(left > 0 && left < 400, "{left} documents are left");
    assert!(block_on(index.store().used_bytes()).unwrap() <= full / 2);
    let newest = index.search("note", &IndexFilter::default(), SearchOrder::Oldest, 1, 0);
    assert_eq!(newest.len(), 1);
    assert!(newest[0].origin_server_ts > 1_000, "the oldest are gone");
    let floor = block_on(index.store().floor(room())).unwrap();
    assert_eq!(floor, newest[0].origin_server_ts.min(floor));
    assert!(floor > 1_000);
    assert!(
        index
            .search("399", &IndexFilter::default(), SearchOrder::Rank, 5, 0)
            .iter()
            .any(|hit| hit.event_id.as_str() == "$d399"),
        "the newest survive"
    );
}

#[test]
fn a_budget_that_fits_evicts_nothing() {
    let index = index_of(&["one", "two"]);
    let evicted = block_on(index.store().evict_to(u64::MAX)).unwrap();

    assert_eq!(evicted, Vec::<OwnedRoomId>::new());
    assert_eq!(index.len(), 2);
}

#[test]
fn a_forgotten_room_leaves_nothing_behind() {
    let index = index_of(&["delegate this", "and that"]);
    index.mark_classified(room(), matrix_sdk::ruma::event_id!("$0"), 0);

    block_on(index.store().forget_room(room())).unwrap();

    assert_eq!(index.len(), 0);
    assert_eq!(ranked(&index, "delegate"), Vec::<u32>::new());
    assert_eq!(
        block_on(index.store().rooms()).unwrap(),
        Vec::<OwnedRoomId>::new()
    );
    assert!(!block_on(index.store().is_classified(room(), "$0")).unwrap());
}

fn wire_index() -> MessageIndex {
    let connection = open_connection(&Location::Memory, None).unwrap();
    MessageIndex::with_store(Store::from_exec(Exec::Wire(Arc::new(
        parking_lot::Mutex::new(connection),
    ))))
}

fn fill(index: &MessageIndex, bodies: &[&str]) {
    for (position, body) in bodies.iter().enumerate() {
        index.upsert(
            room(),
            document(
                &position.to_string(),
                body,
                "@kris:localhost",
                position as u64,
                None,
                Vec::new(),
            ),
        );
    }
}

#[test]
fn over_the_wire_search_ranks_exact_words_above_typos_and_finds_thai() {
    let index = wire_index();
    fill(
        &index,
        &["the deligate came", "the delegate came", "สวัสดีครับทุกคน"],
    );

    assert_eq!(ranked(&index, "delegate"), [1, 0]);
    assert_eq!(
        ranked_words(&index, "สวัสดี", &["สวัสดี"], SearchOrder::Rank),
        [2]
    );
}

#[test]
fn over_the_wire_a_hit_carries_its_neighbours() {
    let index = wire_index();
    fill(&index, &["first line", "needle line", "last line"]);
    let mut hits = index.search("needle", &IndexFilter::default(), SearchOrder::Rank, 5, 0);

    index.context(&mut hits, &[], 1);

    assert_eq!(hits[0].before[0].event_id.as_str(), "$0");
    assert_eq!(hits[0].after[0].event_id.as_str(), "$2");
}

#[test]
fn over_the_wire_the_oldest_documents_are_evicted_and_a_removed_one_is_gone() {
    let index = wire_index();
    for position in 0..300_u64 {
        index.upsert(
            room(),
            document(
                &format!("d{position}"),
                &format!("deploy note number {position} with some padding text to fill pages"),
                "@kris:localhost",
                1_000 + position,
                None,
                Vec::new(),
            ),
        );
    }
    let full = block_on(index.store().used_bytes()).unwrap();
    block_on(index.store().evict_to(full / 2)).unwrap();
    assert!(index.len() < 300);

    index.remove(room(), matrix_sdk::ruma::event_id!("$d299"));
    assert!(
        index
            .search("299", &IndexFilter::default(), SearchOrder::Rank, 5, 0)
            .is_empty()
    );
}

fn assert_stats_are_filled(index: &MessageIndex) {
    fill(
        index,
        &["deploy pipeline", "another deploy note", "third message"],
    );

    let stats = block_on(index.store().stats()).unwrap();

    assert_eq!(stats.documents, 3);
    assert!(
        stats.memory_used > 0,
        "the page cache holds the pages just written"
    );
    assert_eq!(stats.memory_budget, 64 * 1024 * 1024);
    assert!(stats.disk > 0);
    assert!(stats.disk_index > 0, "the full-text index takes pages");
    assert!(stats.disk_bookkeeping > 0);
    assert!(stats.disk_index + stats.disk_bookkeeping < stats.disk);
}

#[test]
fn the_native_executor_reports_real_statistics() {
    assert_stats_are_filled(&MessageIndex::new());
}

#[test]
fn the_wire_executor_reports_real_statistics() {
    assert_stats_are_filled(&wire_index());
}
