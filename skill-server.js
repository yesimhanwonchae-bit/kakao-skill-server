// ============================================
// 카카오 오픈빌더 스킬 서버
// 기능: 슬래시(/) 기반 상담 접수 양식 검증 + 구글 시트 저장
// 구글 시트 ID: 1fSElgikFPF1Er-SeK4AiCe5FwsKlYeYkE_j7oi7W0UI
// ============================================

const express = require('express');
const https = require('https');
const app = express();
app.use(express.json());

const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL || '';
const PORT = process.env.PORT || 3000;

// ============================================
// 1. 접수 양식 파싱 함수 (슬래시 기반 검증)
// ============================================
function parseInquiry(text) {
  const result = {
    name: null,
    business: null,
    phone: null,
    content: null,
    isValid: false,
  };

  // 슬래시(/)를 기준으로 텍스트 분리 및 앞뒤 공백 제거
  const parts = text.split('/').map(p => p.trim());

  // 최소 4개의 덩어리가 있어야 함 (이름/상호명/연락처/상담내용)
  if (parts.length >= 4) {
    result.name = parts[0];
    result.business = parts[1];
    result.phone = parts[2];
    // 상담내용 뒤쪽에 혹시 모를 슬래시(/)가 더 있더라도 하나로 합쳐줌
    result.content = parts.slice(3).join('/').trim();
  }

  // 전화번호 패턴 검증
  const phonePattern = /01[016789]-?\d{3,4}-?\d{4}|0[2-9]\d?-?\d{3,4}-?\d{4}/;
  const isPhoneValid = result.phone && phonePattern.test(result.phone);

  // 4가지 항목이 모두 입력되었고, 연락처 형식이 맞을 때만 유효 처리
  result.isValid = !!(result.name && result.business && result.phone && isPhoneValid && result.content);
  
  return result;
}

// ============================================
// 2. 구글 시트 저장 함수 (Apps Script 웹훅 호출)
// ============================================
function saveToSheet(data) {
  return new Promise((resolve, reject) => {
    if (!GOOGLE_SCRIPT_URL) {
      console.warn('[경고] GOOGLE_SCRIPT_URL 환경변수가 설정되지 않았습니다.');
      return resolve('skipped');
    }

    const body = JSON.stringify(data);

    function doRequest(targetUrl, attempt) {
      const url = new URL(targetUrl);
      const isPost = attempt === 1;

      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: isPost ? 'POST' : 'GET',
        headers: isPost
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            }
          : {},
      };

      const req = https.request(options, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          console.log('[리다이렉트]', res.statusCode, '→', res.headers.location);
          return doRequest(res.headers.location, attempt + 1);
        }

        let responseData = '';
        res.on('data', chunk => (responseData += chunk));
        res.on('end', () => {
          console.log('[시트 응답]', res.statusCode, responseData.substring(0, 100));
          resolve(responseData);
        });
      });

      req.setTimeout(4000, () => {
        console.warn('[타임아웃] 구글 시트 저장 요청 4초 초과');
        req.destroy();
        resolve('timeout');
      });

      req.on('error', (err) => {
        console.error('[시트 저장 오류]', err.message);
        reject(err);
      });

      if (isPost) req.write(body);
      req.end();
    }

    doRequest(GOOGLE_SCRIPT_URL, 1);
  });
}

// ============================================
// 3. 카카오 응답 포맷 생성 함수
// ============================================
function kakaoResponse(message) {
  return {
    version: '2.0',
    template: {
      outputs: [
        {
          simpleText: {
            text: message,
          },
        },
      ],
    },
  };
}

// ============================================
// 4. 메인 스킬 엔드포인트
// POST /kakao/skill
// ============================================
app.post('/kakao/skill', async (req, res) => {
  const userText = req.body?.userRequest?.utterance || '';
  console.log('[수신 메시지]', userText);

  const parsed = parseInquiry(userText);

  if (parsed.isValid) {
    try {
      const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

      await saveToSheet({
        name: parsed.name,
        business: parsed.business,
        phone: parsed.phone,
        content: parsed.content,
        timestamp,
      });
      console.log('[접수 완료]', parsed);
    } catch (err) {
      console.error('[시트 저장 실패]', err.message);
    }

    return res.json(
      kakaoResponse(
        `✅ 접수되었습니다!\n\n` +
        `이름: ${parsed.name}\n` +
        `상호명: ${parsed.business}\n` +
        `연락처: ${parsed.phone}\n` +
        `상담내용: ${parsed.content}\n\n` +
        `담당자가 확인 후 연락드리겠습니다. 😊`
      )
    );
  } else {
    // 슬래시 양식 검증 실패 시 안내 메시지 변경
    return res.json(
      kakaoResponse(
        `양식에 맞게 접수해 주세요. 🙏\n\n` +
        `📌 슬래시(/)로 항목을 구분해서 한 줄로 입력해 주셔야 합니다.\n` +
        `👉 형식: 이름/상호명/연락처/상담내용\n\n` +
        `📝 예시:\n` +
        `홍길동/길동컴퍼니/010-1234-5678/세금계산서 발행 문의합니다.`
      )
    );
  }
});

// ============================================
// 5. 서버 상태 확인용 엔드포인트
// ============================================
app.get('/', (req, res) => {
  res.send('카카오 스킬 서버 정상 작동 중 ✅');
});

app.listen(PORT, () => {
  console.log(`✅ 카카오 스킬 서버 실행 중 → http://localhost:${PORT}`);
});
