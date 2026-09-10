# Grok Video Studio

Ứng dụng local tạo video qua giao diện Grok bằng Playwright, nhận đầu vào từ chủ đề, video tải lên hoặc liên kết YouTube.

## Cài đặt và chạy

```powershell
npm install
npm run install:browser
npm start
```

Chạy kiểm thử cục bộ (không gọi ChatGPT/Grok và không tốn lượt tạo video):

```powershell
npm test
```

Mở `http://localhost:3210`, lần lượt bấm **Đăng nhập ChatGPT** và **Đăng nhập Grok**, đăng nhập trong hai cửa sổ Chromium rồi quay lại app. Phiên được giữ riêng tại `data/chatgpt-browser-profile` và `data/browser-profile`. Thư mục `data/gemini-browser-profile` cũ (chứa phiên đăng nhập Google) không còn được dùng; bạn có thể tự xóa nếu muốn.

## Lưu ý

- Không đóng các cửa sổ Chromium khi hàng đợi đang chạy.
- ChatGPT hoặc Grok có thể thay đổi giao diện. Bộ tự động hóa dùng role/accessible name thay vì CSS cứng; selector tập trung ở `lib/chatgpt.js` và `lib/grok.js`.
- Chỉ tải và tái sử dụng video YouTube khi bạn có quyền. Một số video giới hạn tuổi/DRM/đăng nhập có thể không tải được.
- Chế độ YouTube dùng bản `yt-dlp` Windows được ghim phiên bản và kiểm tra SHA-256; binary chính thức được tải vào `data/tools` ở lần dùng đầu tiên.
- Kết quả nằm trong `data/outputs`. Mỗi lần tạo chạy tuần tự để tránh xung đột một phiên Grok.
- Với video tải lên hoặc YouTube: ChatGPT **không nhận file video** như Gemini trước đây, nên app dùng FFmpeg trích đều tối đa 36 khung hình (khoảng 2 giây một khung), ghép thành các ảnh lưới 3×3 rồi gửi lên ChatGPT kèm chú thích thời gian của từng ảnh. **Âm thanh gốc bị mất**: lời thoại, lời dẫn và nhạc trong video nguồn không được phân tích; prompt dặn ChatGPT không tự bịa ra. ChatGPT trả một kế hoạch JSON gồm `ceil(thời lượng / độ dài clip)` prompt tự chứa nhưng dùng chung mô tả đồng nhất; kế hoạch này được cache để **Thử lại** không phải phân tích lại.
- Riêng chế độ **Video gốc**, có thể tích **Viết câu chuyện dựa trên video**. ChatGPT sáng tác thêm một truyện bám sát nhân vật, bối cảnh và diễn biến nguồn; file UTF-8 gồm `Tiêu đề` và `Nội dung` được lưu tại `data/outputs/<job-id>-story.txt`. Đây là đầu ra phụ, không thay đổi prompt part hay luồng Grok–FFmpeg.
- Grok nhận prompt văn bản cho từng part, kèm ảnh tham chiếu khi được bật (xem mục dưới), và được đặt **Video · theo độ dài clip đang chọn**, ưu tiên **1080p** rồi tự động dùng **720p** khi 1080p không khả dụng. Tỷ lệ khung hình bám theo video nguồn gần nhất trong các lựa chọn Grok hiện có: `16:9`, `9:16`, `1:1`, `3:2`, `2:3`; chế độ chủ đề mặc định `16:9`. App kiểm tra lại cả tỷ lệ lẫn kích thước file tải về và từ chối kết quả thấp hơn 720p.
- **Ảnh tham chiếu** giúp các đoạn nối nhau giữ được nhân vật và bối cảnh. App gửi kèm tối đa `MAX_REFERENCE_IMAGES` (mặc định 3) ảnh cho mỗi part, theo thứ tự: ảnh bạn tự tải lên → frame cắt từ đúng khoảng thời gian của video nguồn → frame cuối của đoạn liền trước. Ô **Dùng ảnh tham chiếu tự động** (bật sẵn) điều khiển hai loại frame tự động; ảnh bạn tải lên luôn được dùng nếu có. Chế độ **Chủ đề** không có video nguồn nên chỉ nối frame cuối đoạn trước.
- Vì frame cuối của đoạn trước là một phần dấu vân tay của đoạn sau, khi một đoạn được tạo lại thì mọi đoạn phía sau cũng tạo lại theo. **Thử lại** vẫn tiết kiệm như trước: các đoạn đã xong được tái dùng nên frame nối của chúng không đổi.
- Ảnh tham chiếu tự động là tệp tạm trong `data/outputs`, xóa ngay sau khi dùng xong. Ảnh bạn tải lên nằm trong `data/uploads` và được giữ để **Thử lại**/**Tạo lại** dùng lại; mỗi ảnh tối đa 20 MB.
- Với nhiều part, FFmpeg chuẩn hóa tất cả clip về cùng mức phân giải thực tế (1080p hoặc 720p), 30 FPS và AAC stereo 48 kHz rồi mới ghép. Nội dung đầy đủ của mỗi clip được giữ lại; app không cắt clip cuối để ép khớp thời lượng nguồn, nên video nguồn 36 giây cho đầu ra khoảng 45 giây khi dùng clip 15 giây.
- Mọi bước cần ChatGPT trả JSON (kế hoạch video, xu hướng, truyện, phân cảnh) **tự thử lại tối đa `CHATGPT_JSON_MAX_ATTEMPTS` lần** (mặc định 3, tối đa 6) ngay trong cùng cuộc trò chuyện, mỗi lần nêu lại đúng lỗi phân tích. Nguyên nhân lỗi JSON hay gặp là giao diện ChatGPT hiển thị câu trả lời dạng Markdown nên làm mất dấu `\` trước ngoặc kép; vì vậy app yêu cầu JSON nằm trong khối code ```json, đọc thẳng nội dung khối code, và tự vá ngoặc kép lạc khi ChatGPT không làm theo.
- chatgpt.com vẫn hiện ô chat khi **chưa đăng nhập**, nên app nhận biết phiên bằng nút **Log in** / **Sign up** thay vì ô nhập. Nếu trang hiện màn xác minh chống bot, hãy tự hoàn tất trong cửa sổ trình duyệt rồi bấm **Thử lại** — app không tự vượt bước này. App giới hạn tệp upload local ở 1 GB.
- Tác vụ tạo từ thời còn dùng Gemini vẫn **Thử lại** được: khi khởi động, server tự đổi các trường kế hoạch/câu chuyện đã cache sang tên mới nên không phải chạy lại bước AI.
- Nút **Hủy** dừng tác vụ đang chờ hoặc đang chạy. Tác vụ đang chờ dừng ngay; tác vụ đang chạy được đánh dấu rồi dừng ở bước an toàn gần nhất — thường vài giây khi đang chờ ChatGPT/Grok, chậm nhất là hết timeout của thao tác trình duyệt đang dở. Lượt Grok đã gửi đi thì không lấy lại được.
- Ba nút xử lý tác vụ đã dừng, khác nhau ở chỗ tái dùng gì:
  - **Thử lại** (tác vụ lỗi hoặc đã hủy): tiếp tục từ đoạn còn dở, **giữ lại** các clip đã tạo xong nếu khớp dấu vân tay. Rẻ nhất.
  - **Tạo lại video** (tác vụ xong, lỗi hoặc đã hủy): giữ nguyên kế hoạch ChatGPT đã cache nhưng **xóa hết clip cũ** để Grok dựng lại video từ đầu. Không phân tích/nghiên cứu lại, chỉ tốn lượt Grok.
  - **Xóa**: bỏ hẳn tác vụ và mọi tệp của nó.

- **Độ dài mỗi clip Grok** lấy theo `GROK_CLIP_SECONDS` (mặc định `15,10`; Grok đang có 5s/10s/15s). Giá trị đầu tiên được dùng cho tác vụ mới. Clip 15 giây tốn ít lượt hơn: video 60 giây chỉ cần **4 part thay vì 6**. Thời lượng đích phải là bội số của độ dài clip, và ô nhập trên giao diện tự đổi bước nhảy theo cấu hình này.
- Độ dài clip được chốt ngay khi tạo tác vụ vì kế hoạch ChatGPT, dấu vân tay và bước ghép FFmpeg đều bám theo nó. Tác vụ tạo từ trước khi có tùy chọn này được giữ nguyên ở 10 giây nên **Thử lại** vẫn tái dùng được kế hoạch và clip đã có; đổi cấu hình chỉ ảnh hưởng tác vụ mới.
- Nếu Grok bỏ mất độ dài mà tác vụ đang cần, app báo lỗi rõ kèm danh sách lựa chọn Grok thực sự có, thay vì lặng lẽ tạo clip sai độ dài.
- Mặc định app nhận tối đa 30 part để tránh vô tình tiêu hàng trăm lượt Grok; có thể đổi bằng `MAX_VIDEO_PARTS`.
- **Tự đăng Facebook Reels**: tích ô *Tự đăng Facebook Reels khi xong* để video được đăng công khai lên Facebook Page ngay sau khi ghép. Cần đặt `FACEBOOK_PAGE_ID` và `FACEBOOK_PAGE_ACCESS_TOKEN`; chưa có thì ô này bị ẩn và app từ chối tạo tác vụ có bật Reels.
- Reels **chỉ đăng được lên Facebook Page**, không đăng lên trang cá nhân hay Group. Token cần quyền `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`; dùng cho Page của người khác thì phải qua App Review của Meta.
- Reels bắt buộc **tỷ lệ 9:16, dài 3–90 giây**, tối thiểu 540x960. Bật ô này thì chế độ Chủ đề tự chuyển sang 9:16 và thời lượng trên 90 giây bị từ chối ngay lúc tạo. Video nguồn ngang sẽ bị từ chối sau khi ghép — tác vụ vẫn *Hoàn tất* và giữ video, chỉ báo *Không hợp lệ cho Reels*.
- Đăng lỗi **không làm hỏng tác vụ**: video đã tốn lượt Grok nên vẫn giữ nguyên và tải về được; kết quả đăng nằm ở trạng thái Reels riêng trên thẻ tác vụ.
- Caption lấy theo thứ tự: chủ đề ChatGPT tự chọn → tiêu đề câu chuyện → prompt bạn nhập. Thêm hashtag cố định bằng `FACEBOOK_REEL_HASHTAGS`.
- Access token chỉ đi trong header `Authorization`, không bao giờ nằm trong URL, và bị che khỏi mọi log lẫn thông báo lỗi.
- Mỗi tác vụ mới có log JSON Lines riêng trong `data/logs/<job-id>.log`. Kế hoạch đầy đủ có liên kết **Kịch bản ChatGPT**; lỗi ChatGPT/Grok lưu ảnh chụp và HTML chẩn đoán riêng.
- Web server chỉ lắng nghe trên `127.0.0.1`; log, phiên đăng nhập và video nguồn không được mở ra mạng LAN.
- URL và timeout có thể cấu hình bằng các biến trong `.env.example` (PowerShell có thể đặt trực tiếp vào môi trường trước khi chạy).

Theo tài liệu xAI hiện tại, API Imagine chính thức cũng hỗ trợ text-to-video và edit-video. App này chủ ý dùng Playwright để tận dụng phiên đăng nhập/gói Grok theo yêu cầu, nên độ ổn định phụ thuộc giao diện web.
