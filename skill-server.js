// ============================================
// 카카오 오픈빌더 스킬 서버
// 기능: 엄격한 상담 접수 양식 검증 + 구글 시트 저장
// 구글 시트 ID: 1fSElgikFPF1Er-SeK4AiCe5FwsKlYeYkE_j7oi7W0UI
// ============================================

const express = require('express');
const https = require('https');
const app = express();
app.use(express.json());

const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL || '';
const PORT = process.env.PORT || 3000;

// ============================================
// 1. 접수 양식 파싱 함수 (강제 검증 적용)
// ============================================
function parseInquiry(text) {
  const result = {
    name: null,
    business: null, // 상호명 필드 추가
    phone: null,
    content: null,
    isValid: false,
  };

  // 줄바꿈 기준으로 텍스트 분리
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let contentLines = [];
  let isContentParsing = false;

  for (const line of lines) {
    // 지정된 키워드와 콜론(:)이 앞부분에 정확히 있는지 정규식으로 검증
    if (line.match(/^이름\s*[:：]/)) {
      result.name = line.replace(/^이름\s*[:：]\s*/, '').trim();
      isContentParsing = false;
    } else if (line.match(/^상호명\s*[:：]/)) {
      result.business = line.replace(/^상호명\s*[:：]\s*/, '').trim();
      isContentParsing = false;
    } else if (line.match(/^연락처\s*[:：]/)) {
      result.phone = line.replace(/^연락처\s*[:：]\s*/, '').trim();
      isContentParsing = false;
    } else if (line.match(/^상담내용\s*[:：]/)) {
      contentLines.push(line.replace(/^상담내용\s*[:：]\s*/, '').trim());
      isContentParsing = true;
    } else if (isContentParsing) {
      // '상담내용:' 이후에 입력된 줄바꿈 내용들은 모두 본문에 이어붙임
      contentLines.push(line);
    }
  }

  result.content = contentLines.join('\n').trim();

  // 전화번호 패턴 검증 (기존 로직 유지)
  const phonePattern = /01[016789]-?\d{3,4}-?\d{4}|0[2-9]\d?-?\d{3,4}-?\d{4}/;
  const isPhoneValid = result.phone && phonePattern.test(result.phone);

  // 4가지 항목이 모두 빈칸 없이 입력되었고, 연락처 형식이 맞을 때만 유효한 것으로 처리
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
        business: parsed.business, // 웹훅으로 상호명 데이터 전달
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
    // 양식 검증 실패 시 강제 안내 메시지
    return res.json(
      kakaoResponse(
        `양식에 맞게 접수해 주세요. 🙏\n\n` +
        `📌 아래 형식을 복사하여 정확히 입력해 주세요:\n\n` +
        `이름: 홍길동\n` +
        `상호명: 길동컴퍼니\n` +
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
