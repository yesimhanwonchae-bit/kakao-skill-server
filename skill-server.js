// ============================================
// 카카오 오픈빌더 스킬 서버
// 기능: 상담 접수 양식 검증 + 구글 시트 저장
// 구글 시트 ID: 1fSElgikFPF1Er-SeK4AiCe5FwsKlYeYkE_j7oi7W0UI
// ============================================

const express = require('express');
const https = require('https');
const app = express();
app.use(express.json());

const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL || '';
const PORT = process.env.PORT || 3000;

// ============================================
// 1. 접수 양식 파싱 함수
// ============================================
function parseInquiry(text) {
  const result = {
    name: null,
    phone: null,
    content: null,
    isValid: false,
  };

  // 수정: 전화번호 패턴 강화 (010/011/016/017/018/019 휴대폰 + 지역번호)
  const phonePattern = /01[016789]-?\d{3,4}-?\d{4}|0[2-9]\d?-?\d{3,4}-?\d{4}/;
  const lines = text.split(/[\n,]/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (/이름|상호|업체|성함/.test(line)) {
      result.name = line.replace(/.*?[：:]\s*/, '').trim();
    } else if (/연락처|전화|번호/i.test(line)) {
      result.phone = line.replace(/.*?[：:]\s*/, '').trim();
    } else if (/상담|문의|내용/.test(line)) {
      // 수정: 상담내용 키워드가 있으면 해당 줄부터 끝까지 합치기
      const idx = lines.indexOf(line);
      result.content = lines.slice(idx).map(l => l.replace(/.*?[：:]\s*/, '')).join(' ').trim();
      break;
    }
  }

  // 키워드 없이 순서대로 입력한 경우 보완
  if (!result.name && lines[0] && !phonePattern.test(lines[0])) {
    result.name = lines[0];
  }
  if (!result.phone) {
    const m = text.match(phonePattern);
    if (m) result.phone = m[0];
  }
  // 수정: 3번째 줄 이후 전부 합치기 (기존엔 마지막 줄만 가져옴)
  if (!result.content && lines.length >= 3) {
    result.content = lines.slice(2).join(' ');
  }

  result.isValid = !!(result.name && result.phone && result.content);
  return result;
}

// ============================================
// 2. 구글 시트 저장 함수 (Apps Script 웹훅 호출)
// 수정: 302 리다이렉트 자동 처리 + 타임아웃 4초
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
        // 수정: 302 리다이렉트 → Location 헤더로 재요청
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

      // 수정: 4초 타임아웃 (카카오 5초 제한 대응)
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
      // 수정: 한국 시간 타임스탬프 추가
      const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

      await saveToSheet({
        name: parsed.name,
        phone: parsed.phone,
        content: parsed.content,
        timestamp,           // 구글 시트에 접수 시간 기록
      });
      console.log('[접수 완료]', parsed);
    } catch (err) {
      console.error('[시트 저장 실패]', err.message);
      // 저장 실패해도 사용자에게는 접수 완료 안내
    }

    return res.json(
      kakaoResponse(
        `✅ 접수되었습니다!\n\n` +
        `이름/상호명: ${parsed.name}\n` +
        `연락처: ${parsed.phone}\n` +
        `상담내용: ${parsed.content}\n\n` +
        `담당자가 확인 후 연락드리겠습니다. 😊`
      )
    );
  } else {
    return res.json(
      kakaoResponse(
        `양식에 맞게 접수해 주세요. 🙏\n\n` +
        `📌 아래 형식으로 입력해 주세요:\n\n` +
        `이름/상호명: 홍길동\n` +
        `연락처: 010-1234-5678\n` +
        `상담내용: 세금계산서 문의`
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
