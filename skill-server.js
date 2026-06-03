// ============================================
// 카카오 오픈빌더 스킬 서버
// 기능: 상담 접수 양식 검증 + 구글 시트 저장
// ============================================

const express = require('express');
const https = require('https');
const app = express();
app.use(express.json());

// ✅ 환경변수에서 구글 Apps Script URL 가져오기
// Railway Variables에 GOOGLE_SCRIPT_URL 등록 필요
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL || '';
const PORT = process.env.PORT || 3000;

// ============================================
// 1. 접수 양식 파싱 함수
// 이름/상호명, 연락처, 상담내용 추출
// ============================================
function parseInquiry(text) {
  const result = {
    name: null,
    phone: null,
    content: null,
    isValid: false,
  };

  const phonePattern = /0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/;
  const lines = text.split(/[\n,]/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (/이름|상호|업체|성함/.test(line)) {
      result.name = line.replace(/.*?[：:]\s*/, '').trim();
    } else if (/연락처|전화|번호/i.test(line)) {
      result.phone = line.replace(/.*?[：:]\s*/, '').trim();
    } else if (/상담|문의|내용/.test(line)) {
      result.content = line.replace(/.*?[：:]\s*/, '').trim();
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
  if (!result.content && lines.length >= 3) {
    result.content = lines[lines.length - 1];
  }

  // 유효성 검사: 이름 + 연락처 + 상담내용 모두 있어야 함
  result.isValid = !!(result.name && result.phone && result.content);
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
    const url = new URL(GOOGLE_SCRIPT_URL);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      // Apps Script는 302 리다이렉트 응답을 줌 — 성공으로 간주
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        console.log('[시트 응답]', res.statusCode, responseData.substring(0, 100));
        resolve(responseData);
      });
    });

    req.on('error', (err) => {
      console.error('[시트 저장 오류]', err.message);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

// ============================================
// 3. 카카오 응답 포맷 생성 함수
// ============================================
function kakaoResponse(message) {
  return {
    version: "2.0",
    template: {
      outputs: [
        {
          simpleText: {
            text: message
          }
        }
      ]
    }
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
    // ✅ 양식 정상 — 구글 시트 저장 후 접수 완료 안내
    try {
      await saveToSheet({
        name: parsed.name,
        phone: parsed.phone,
        content: parsed.content,
      });
      console.log('[접수 완료]', parsed);
    } catch (err) {
      console.error('[시트 저장 실패]', err.message);
      // 저장 실패해도 사용자에게는 접수 완료 안내
    }

    return res.json(kakaoResponse(
      `✅ 접수되었습니다!\n\n` +
      `이름/상호명: ${parsed.name}\n` +
      `연락처: ${parsed.phone}\n` +
      `상담내용: ${parsed.content}\n\n` +
      `담당자가 확인 후 연락드리겠습니다. 😊`
    ));

  } else {
    // ❌ 양식 불일치 — 재입력 안내
    return res.json(kakaoResponse(
      `양식에 맞게 접수해 주세요. 🙏\n\n` +
      `📌 아래 형식으로 입력해 주세요:\n\n` +
      `이름/상호명: 홍길동\n` +
      `연락처: 010-1234-5678\n` +
      `상담내용: 세금계산서 문의`
    ));
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
