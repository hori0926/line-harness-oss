-- Migration NNN: 管理画面 1:1 チャットの「誰が返信したか」の記録
--
-- 手動返信 (source='manual') は今まで「誰かが返した」ことしか残らず、複数
-- スタッフで顧客対応すると担当の突き合わせも監査もできなかった。送信時の
-- スタッフ identity を messages_log に控える。
--
-- sent_by_staff_id:
--   送信したスタッフの staff_members.id。認証情報から取れない経路 (env
--   API_KEY による owner フォールバック等) では NULL。
-- sent_by_staff_name:
--   送信時点のスタッフ表示名の **スナップショット**。id から JOIN で引く形に
--   すると、スタッフが退職して staff 行が消えた瞬間に過去ログの「誰が送ったか」
--   が全部 NULL に化けてしまい、監査記録として成立しない。名前を別に持つのは
--   そのため。同じ理由で外部キーにはしない (staff 行の削除でログを壊さない /
--   ON DELETE SET NULL で消えない)。改名後の表示は当時の名前のままになるが、
--   「その時どう名乗っていたか」が残るほうが監査としては正しい。
--
-- 既存 DB への影響:
--   additive-only (ADD COLUMN のみ)。既存行は両列とも NULL になり、送信者
--   不明の (= 従来どおりの) メッセージとして扱われる。自動配信 (broadcast /
--   scenario / 自動応答) は送信者がスタッフではないので常に NULL のままで、
--   これは欠損ではなく「人が送っていない」ことを表す正しい値。

ALTER TABLE messages_log ADD COLUMN sent_by_staff_id TEXT;
ALTER TABLE messages_log ADD COLUMN sent_by_staff_name TEXT;
