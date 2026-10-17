# API 摘要

完整型別見啟動後 `/docs`。寫入需要 JSON、`X-Requested-With: portfolio` 及同源工作階段 Cookie。時間輸入 ISO 8601 且帶時區，輸出 UTC epoch 秒。

| 方法 / 路徑 | 用途 |
|---|---|
| POST `/api/register`、`/api/login`、`/api/logout` | 帳號與工作階段 |
| GET `/api/me` | 目前使用者 |
| GET `/api/events` | 公開活動摘要，最多 100 筆，查詢時整理期限 |
| POST `/api/events` | 登入者建立活動，不自動佔位 |
| GET `/api/events/{id}` | 公開摘要 + 本人狀態；依權限加名單及主辦流程紀錄 |
| POST `/api/events/{id}/join` | 尚未截止：直接確認或加入候補；重複有效報名不新增 |
| POST `/api/events/{id}/leave` | 開始前退出或放棄保留，依序補位 |
| POST `/api/events/{id}/accept` | 接受本人有效候補邀請，過期回 409 |
| POST `/api/events/{id}/cancel` | 開始前主辦取消，寫入站內通知 |
| POST `/api/events/{id}/check-in/{user_id}` | 主辦記錄已確認者出席；限已截止成團與時間窗 |
| POST `/api/events/{id}/settle` | 主辦於結束後依已簽到者結算；重複呼叫回同一快照 |
| GET `/api/notifications` | 本人最近 50 則通知，亦整理相關未截止活動 |
| POST `/api/notifications/{id}/read` | 只有本人可標已讀 |
| GET `/api/events/{id}/calendar.ics` | 公開活動資訊下載，不含參與者 |

建立活動範例（請換成當時的未來時間）：

```json
{
  "title":"週五羽球臨打", "sport":"羽球", "venue":"示範校園場館",
  "starts_at":"2027-01-08T19:00:00+08:00",
  "ends_at":"2027-01-08T21:00:00+08:00",
  "cutoff_at":"2027-01-08T17:00:00+08:00",
  "capacity":6, "minimum":4, "total_cost":600, "offer_minutes":15,
  "backup_plan":"場館關閉時由主辦人取消並另行聯絡"
}
```

2 ≤ minimum ≤ capacity ≤ 32；截止 < 開始 < 結束，最長 24 小時，開始在一年內。整數費用 0–100000，候補期限 1–120 分鐘且不得超過成團截止。未知欄位或不帶時區回 422；未登入 401、主辦權限不足 403、找不到 404、領域衝突 409、節流 429。

我的報名欄位 mine 可能是 null，或含 status、deadline。deadline 只對 offered 有意義。等待與已保留是不同狀態；使用者須看實際回應，不能把所有 200 都當「已確認參加」。
