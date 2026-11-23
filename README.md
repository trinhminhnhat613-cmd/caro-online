# Caro Online

Caro (5 quân liên tiếp) realtime cho 2 người, kèm chat, emoji, nhãn dán, lưu & xem lại ván.
Server Node thuần (tự cài WebSocket) — **không cần `npm install`**.

## Chạy thử trên máy
    node server.js          # cần Node 18+
    # mở http://localhost:3000 ; mở thêm tab ẩn danh để đóng vai người thứ 2

## Đưa lên mạng để bạn ở Philippines chơi cùng
Cần một nơi chạy Node **liên tục** có WebSocket (Vercel/Netlify serverless KHÔNG dùng được).
Chọn máy chủ ở **Singapore** để cả Việt Nam và Philippines đều có ping thấp (~30–60 ms).

**Render.com** (dễ nhất): New → Web Service → kết nối repo → Build: để trống · Start: `node server.js`
→ Region: Singapore → thêm *Disk* gắn vào `/data` và biến môi trường `DATA_DIR=/data`
(để ván đấu không mất khi server khởi động lại; cần gói trả phí có Disk).
**Fly.io / Railway / VPS**: dùng Dockerfile có sẵn, gắn volume vào `/data`.
Trang tự dùng `wss://` khi chạy HTTPS.

## Tính năng chính
- Tạo phòng gửi link, hoặc "Ghép ngẫu nhiên"; cỡ bàn 10/13/15/19/25; zoom bàn cờ bằng thanh trượt.
- Mất kết nối: giữ chỗ **2 phút**; trình duyệt tự nối lại, vào lại đúng trận. Hết 2 phút → đối thủ thắng.
- Server kiểm tra mọi nước đi (không gian lận được); đi nước trước, server xác nhận sau nên không cảm giác trễ.
- Mỗi ván lưu thành `data/games/<id>.json` (nước đi + chat), xem lại ở "Lịch sử" hoặc qua link `#/replay/<id>`.
- Nhãn dán: có sẵn bộ emoji lớn; thêm ảnh riêng bằng cách bỏ file vào `public/stickers/`.

## Biến môi trường
PORT (mặc định 3000) · DATA_DIR (mặc định ./data) · GRACE_MS (mặc định 120000)
