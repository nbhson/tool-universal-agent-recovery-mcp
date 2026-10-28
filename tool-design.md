# Tool Design

## Danh sách MCP Tools

| Tool | Chức năng |
|------|-----------|
| `register_task` | Đăng ký task và agent cần theo dõi |
| `report_progress` | Báo tiến độ |
| `save_checkpoint` | Lưu trạng thái có thể phục hồi |
| `report_interruption` | Báo lỗi hoặc gián đoạn |
| `get_task_status` | Xem trạng thái task |
| `mark_completed` | Đánh dấu hoàn thành sau khi xác minh |
| `cancel_task` | Hủy task và yêu cầu dừng recovery |

## Lưu ý kiến trúc

Watchdog có thể sử dụng cùng SQLite để truy xuất trạng thái, không nhất thiết phải gọi MCP tool của chính nó. Điều này tránh việc thiết kế vòng phụ thuộc không cần thiết.

## Trạng thái task (State Machine)

Các trạng thái task nên thống nhất:

| Trạng thái | Ý nghĩa |
|------------|---------|
| `REGISTERED` | Task đã đăng ký |
| `RUNNING` | Agent đang thực thi |
| `INTERRUPTED` | Có dấu hiệu bị gián đoạn |
| `RECOVERING` | Watchdog đang phục hồi |
| `COMPLETED` | Task hoàn thành và đã xác minh |
| `BLOCKED` | Không thể tự phục hồi |
| `CANCELLED` | Người dùng đã hủy |
