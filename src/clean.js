// 대답에서 이모지와 글자 표정(:) ^^ 등)을 걷어 낸다.
// 모델에게도 쓰지 말라고 하지만, 가끔 새어 나오는 것을 화면에 나가기 전에 한 번 더 막는다.
const EMOJI = /[\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1FAFF}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu
const FACES = /(^|\s)(?:[:;=]-?[)(DPp3]|\^[_\-.o]?\^|>[_.]<|[Tㅜㅠ]_[Tㅜㅠ]|x[Dd])(?=$|[\s.,!?~])/gm

const NO_EMOJI_RULE =
  '이모지와 이모티콘은 절대 쓰지 마. 그림 문자도, :) 나 ^^ 같은 글자 표정도 안 돼. 기분은 말로만 표현해.'

function stripEmoji(text) {
  return String(text)
    .replace(EMOJI, '')
    .replace(FACES, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,!?~])/g, '$1')
    .replace(/[ \t]+$/gm, '')
}

module.exports = { stripEmoji, NO_EMOJI_RULE }
