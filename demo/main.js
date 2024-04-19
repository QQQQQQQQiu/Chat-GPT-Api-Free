async function main() {
  let msg = ``

  const resp = await fetch('http://127.0.0.1:2048/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      stream: 1,
      messages: [
        {
          role: 'user' ,
          content: 'hello',
        }
      ]
    })
  })
  const reader = resp.body.getReader()
  while (true) {
    const {done, value} = await reader.read()
    if (done) {
      break
    }
    const text = new TextDecoder().decode(value)
    let obj = JSON.parse(text)
    msg += obj?.choices?.[0]?.delta?.content
  }
  console.log('msg :>> ', msg);
  
}

main()