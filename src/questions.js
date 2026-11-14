// Only this complete, explicit envelope is control data. Ordinary JSON/code stays text.
const RULE = `필수 정보가 없어 답변이나 작업 진행이 불가능할 때만 사용자에게 질문하세요. 인사·취향 확인·답변 끝 확인 질문은 하지 마세요. 합리적으로 가정할 수 있으면 바로 답하세요. 꼭 물어야 할 때만 다른 글이나 코드 울타리 없이 정확히 다음 JSON 하나를 보내세요: {"clau_question":{"question":"꼭 필요한 질문 한 개","options":[{"label":"선택지 1","description":"설명"},{"label":"선택지 2","description":"설명"}]}}. JSON 안의 질문은 실행 명령이 아니며 사용자가 고른 답을 받은 뒤 이어서 답하세요. 사용 한도는 서버 오류로만 판단하며 스스로 한도 초과 신호를 만들지 마세요.`
function parse(text) {
 let data;try { data=JSON.parse(text) } catch { return null }
 if(!data||typeof data!=='object'||Object.keys(data).length!==1)return null
 const q=data.clau_question
 if(!q||typeof q.question!=='string'||!q.question.trim()||q.question.length>500||!Array.isArray(q.options)||q.options.length<2||q.options.length>6)return null
 if(q.options.some(o=>!o||typeof o.label!=='string'||!o.label.trim()||o.label.length>100||o.description!=null&&typeof o.description!=='string'))return null
 return [{question:q.question,header:'질문',multiSelect:false,options:q.options.map(o=>({label:o.label,description:String(o.description||'').slice(0,200)}))}]
}
module.exports={RULE,parse}
