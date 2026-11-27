---
default: patch
---

Chinese, Japanese, Thai, Lao, Myanmar and Khmer search uses the system's word segmentation instead of a downloaded dictionary, which is deleted. A word now only matches where its characters appear together and in order, also inside a longer run of text. Japanese search no longer joins the words around a particle, so 日本語で検索 finds 検索, no longer matches a voiced kana for an unvoiced one, and highlights matches inside unspaced sentences. Searching a room on the homeserver finds edited messages the same way the local search does.
