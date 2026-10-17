# 領域模型與一致性

## 分層與資料

前端單一同源 PWA → FastAPI 路由／授權 → domain.py 的 reconcile／split_cost → SQLite。common.py 提供帳號與交易。沒有外部訊息佇列或支付平台。

events：時間、容量、門檻、費用、曾成團旗標、生命週期、結算快照。
registrations：單一活動／帳號唯一，序號為排隊依據，status 與 deadline。
notifications：站內持久通知，已讀依本人隔離。
audit：流程紀錄，只由服務追加，僅主辦可查看；不是防資料庫管理員竄改的密碼學稽核系統。
users / sessions / throttle：共用安全基礎。

## 狀態機

活動持久狀態：open → locked → settled；open 或開場前 locked 可取消。open 呈現 recruiting／ready／at_risk，由確認人數及 was_ready 推導。at_risk 表示「曾達門檻，現在不足」。

報名狀態：直接 confirmed 或 waiting；waiting → offered → confirmed，逾時則 expired；取消則 canceled；confirmed → checked_in。重新排隊會刪除該筆舊報名並新增序號，保留事件層流程紀錄但不保留該帳號每次報名的完整版本史。

容量不變量：confirmed + checked_in + offered ≤ capacity。只有 confirmed + checked_in ≥ minimum 算成團。報名、釋位、到期、接受、簽到、結算都在同一短暫 `BEGIN IMMEDIATE` 交易中執行，不採「先讀容量、交易外再寫」的競態模式。參考 [SQLite 官方交易說明](https://www.sqlite.org/lang_transaction.html)。

逾期處理後的拒絕操作仍會提交期限整理，避免因接受邀請失敗而把逾期狀態回滾。其他資料庫錯誤則回滾。時鐘可注入測試，時間以 UTC epoch 秒儲存，API 輸入必須帶時區，畫面以瀏覽器當地時區顯示。

## 期限與通知

reconcile 依序處理邀請逾期 → 確認人數／曾達標 → 截止成團判斷 → 未截止時按序保留名額。截止時尚未確認的名額不算門檻，也不再自動補位。

讀取活動及個人通知可整理狀態。maintenance.py 是適合外部排程呼叫的一次性命令；執行環境沒有替使用者安裝排程。站內通知與狀態在同一交易提交，不會發生狀態已補位但該通知未寫入的部分提交。沒有送達保證、SMTP 或 Web Push。前端須手動重新整理。

## 費用與行事曆

總費用是非負整數 TWD。結算分母為已簽到人數，零人拒絕。divmod 產生基本金額及餘數，按報名序號讓前 remainder 人各多 1 元，確保加總精確等於總額。首次結算存入快照，重複呼叫回同一份；不因日後暱稱變動重算，也不真正付款。

ICS 只包含公開活動資料；跳脫反斜線、逗號、分號與換行，UTF-8 行折疊不切斷字元，避免插入額外行事曆欄位。下載是當時快照，不會自動訂閱更新或取消通知。

## 安全與部署界線

PBKDF2-SHA256 600,000 次 + 隨機 salt；session 僅存摘要、8 小時過期，Cookie HttpOnly／SameSite=Strict，HTTPS 設 Secure。寫入要求自訂標頭並拒絕異源 Origin；不開放跨域 CORS。CSP 禁止 inline script，文字 HTML escaping，靜態檔白名單。登入及註冊按來源位址固定時窗節流；不代表已完成所有反濫用工作。

未登入只看活動摘要。主辦與曾報名帳號可看暱稱，只有主辦取得簽到用成員 ID 與 audit；個人通知僅本人可讀。活動地點和備案公開，不能填私人住址或敏感資訊。沒有驗證一帳號等於一個真人，沒有名單封鎖功能。

所有讀取也使用相同寫入交易工具，簡化一致性但降低吞吐量；適合單節點小型示範，未做負載測試。活動清單最多顯示 100 筆，以起始時間排序；目前無大型歷史清單分頁、資料庫 schema 遷移或帳號復原。正式部署應使用持久磁碟、HTTPS、可信反向代理設定、備份與還原演練、監控及擴展讀取交易／資料庫。

JSON 宣告長度上限不代替反向代理的實際串流限制。不要對網際網路直接裸露開發伺服器；不要上傳 data/、資料庫、.env 或示範密碼。

## PWA

service worker 只快取公開介面與圖示，線上優先；不攔截 API、外站或寫入。不儲存登入／名單／通知／報名 API 回應，不以離線資料假裝完成操作。網路失敗後重新讀取伺服器狀態，再決定是否重試。快取版本隨介面變更調整；沒有背景同步或推播。
