# DaiLo Wedding — Cloud Backend (Render Web Service)

Backend Node.js độc lập (v15) cho nền tảng thiệp cưới điện tử **DaiLo Wedding**, tương thích 100% với Frontend deploy trên **Vercel** hoặc **GitHub Pages**.

## Tính năng Backend
- API đầy đủ tại `/api`:
  - Xác thực **OTP 6 số bắt buộc** trước khi đăng ký bằng Số điện thoại (10 số VN) hoặc Gmail (`@gmail.com`), hỗ trợ gửi mã thật qua **Resend / Brevo / eSMS / Twilio / Webhook** và chế độ xác thực tức thì.
  - Đăng nhập & **Liên kết / Hủy liên kết** tài khoản trực tiếp **Facebook OAuth 2.0** và **Google OAuth 2.0 / GIS** (bảo vệ chống trùng liên kết và chống mất quyền đăng nhập).
  - Studio quản lý thiệp, Live Chat 2 chiều tách key riêng, Đặt lịch tư vấn chuẩn SĐT 10 số VN, Upload ảnh/nhạc.
- Nhận Webhook tự động từ **SePay / Casso / PayOS** (`/api?action=payment_webhook`) -> tự mở khóa & bàn giao thiệp tức thì sau 3 giây.
- **Gemini AI Agent** tư vấn giá + phân tích Ngũ Hành theo năm sinh (fallback thông minh nếu chưa gắn `GEMINI_API_KEY`).
- Lưu trữ bền vững linh hoạt:
  - **PostgreSQL (`DATABASE_URL`)** — Khuyên dùng cho **Render Free** (kết nối Neon.tech hoặc Supabase Postgres miễn phí vĩnh viễn để không bao giờ mất dữ liệu khi ngủ đông/redeploy).
  - **Persistent Disk (`DATA_DIR=/var/data`)** — Dành cho gói **Render Starter ($7/tháng)** + Disk.
- Health check tại `GET /health` và `HEAD /healthz` (dùng cho Render & UptimeRobot/Cron-job.org).

## Triển khai nhanh lên Render (3 bước)
1. Push thư mục này lên GitHub repo `https://github.com/lochoipes-hue/lamour-cloud-backend`.
2. Trên [dashboard.render.com](https://dashboard.render.com): chọn **New -> Blueprint** (hoặc **New -> Web Service**), chọn repo `lamour-cloud-backend`, Region **Singapore**.
3. Điền các biến môi trường trong **Environment Variables** (xem mẫu trong `.env.example`):
   - `DATABASE_URL`: chuỗi kết nối PostgreSQL từ [Neon.tech](https://neon.tech) (Free vĩnh viễn, chọn vùng **AWS Singapore**).
   - `FRONTEND_URL`: URL Vercel frontend của bạn (VD: `https://lamour-thiep-cuoi.vercel.app`).
   - `SEPAY_API_KEY`: khóa bí mật Webhook bạn tạo trên `my.sepay.vn`.
   - `FACEBOOK_APP_ID` + `FACEBOOK_APP_SECRET`: bật đăng nhập & liên kết Facebook thật.
   - `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`: bật đăng nhập & liên kết Google thật.
   - `RESEND_API_KEY` (hoặc `BREVO_API_KEY` / `OTP_EMAIL_WEBHOOK_URL`): gửi mã OTP 6 số về Gmail thật.
   - `ESMS_API_KEY` + `ESMS_SECRET_KEY` (hoặc `TWILIO_*` / `OTP_SMS_WEBHOOK_URL`): gửi mã OTP 6 số về SĐT thật.
   - `GEMINI_API_KEY` (tuỳ chọn): khóa miễn phí từ [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

## Chạy & kiểm thử tại máy
```bash
npm test
npm start
```
