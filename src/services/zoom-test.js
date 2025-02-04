const axios = require("axios");
const qs = require("qs");

// ✅ Zoom Developer App에서 받은 Client ID 및 Secret 입력
const CLIENT_ID = "DZawubMxQ4SgKWFCghs8Lg";
const CLIENT_SECRET = "y5EuzckooTotQ3vYijEIIBTeBaceEysv";

// 🔹 1. Access Token 발급 함수
async function getAccessToken() {
    const tokenUrl = "https://zoom.us/oauth/token";
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

    try {
        const response = await axios.post(tokenUrl, qs.stringify({
            grant_type: "client_credentials"
        }), {
            headers: {
                Authorization: `Basic ${credentials}`,
                "Content-Type": "application/x-www-form-urlencoded"
            }
        });

        console.log("🔑 Access Token:", response.data.access_token);
        return response.data.access_token;
    } catch (error) {
        console.error("🚨 Error fetching access token:", error.response?.data || error.message);
        return null;
    }
}

// 🔹 2. 사용자 정보 가져오기 함수
async function getUserInfo(accessToken) {
    try {
        const response = await axios.get('https://api.zoom.us/v2/users/me', {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            }
        });
        console.log("👤 User ID:", response.data.id);
        return response.data.id;
    } catch (error) {
        console.error("🚨 Error fetching user info:", error.response?.data || error.message);
        return null;
    }
}

// 🔹 3. Zoom Meeting 생성 함수
async function createMeeting(accessToken) {
    if (!accessToken) {
        console.error("🚨 Access Token이 없습니다. 먼저 getAccessToken()을 실행하세요.");
        return;
    }

    const userId = await getUserInfo(accessToken);
    if (!userId) {
        console.error("🚨 사용자 정보를 가져올 수 없습니다.");
        return;
    }

    const url = `https://api.zoom.us/v2/users/${userId}/meetings`;
    const meetingData = {
        topic: "테스트 회의",
        type: 2, // 예약된 미팅 (즉시 시작 X)
        start_time: new Date().toISOString(), // 즉시 시작
        duration: 30, // 30분 미팅
        timezone: "Asia/Seoul",
        agenda: "Zoom API를 이용한 자동 미팅 생성 테스트",
        settings: {
            host_video: true,
            participant_video: true,
            mute_upon_entry: true,
            waiting_room: false
        }
    };

    try {
        const response = await axios.post(url, meetingData, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            }
        });

        console.log("\n📌 Zoom Meeting Created:");
        console.log("🔗 참가자 링크 (Join URL):", response.data.join_url);
        console.log("🔗 호스트 링크 (Start URL):", response.data.start_url);
    } catch (error) {
        console.error("🚨 Error creating meeting:", error.response?.data || error.message);
    }
}

// 🔹 실행: Access Token 발급 후 미팅 생성
(async () => {
    const token = await getAccessToken();
    await createMeeting(token);
})();