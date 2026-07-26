# Deploy da JV TV no Render

## 1. Antes de tudo

Troque a senha do usuario do MongoDB Atlas, porque credenciais nunca devem ficar em chat, GitHub ou codigo.

## 2. Configure o MongoDB Atlas

No Atlas, libere acesso de rede para o Render em `Network Access`.

Para testar rapido, voce pode usar:

```text
0.0.0.0/0
```

Depois, se quiser endurecer a seguranca, restrinja conforme sua necessidade.

## 3. Importe os canais para o MongoDB

Crie um arquivo `.env` local baseado em `.env.example`:

```text
MONGODB_URI=sua_uri_nova_do_mongodb
MONGODB_DB=jv_tv
MONGODB_COLLECTION=channels
ADMIN_TOKEN=um_token_forte
```

Depois rode:

```bash
npm run seed:mongo
```

Esse comando usa o arquivo local `data/channels.json`, que nao vai para o GitHub.

## 4. Crie o Web Service no Render

No Render:

1. Clique em `New`.
2. Escolha `Web Service`.
3. Conecte o GitHub.
4. Selecione o repositorio `josineivieira/TV-FECHADA`.
5. Configure:

```text
Runtime: Node
Build Command: npm install
Start Command: npm start
Branch: main
```

## 5. Variaveis de ambiente no Render

Em `Environment`, adicione:

```text
MONGODB_URI=sua_uri_nova_do_mongodb
MONGODB_DB=jv_tv
MONGODB_COLLECTION=channels
ADMIN_TOKEN=um_token_forte
PLAYBACK_MODE=direct
```

Nao coloque `PORT`: o Render define automaticamente.

Use `PLAYBACK_MODE=proxy` para tentar esconder as origens pelo backend. Se a origem bloquear o Render com erro 403, use `PLAYBACK_MODE=direct` para tocar direto no navegador.

## 6. Deploy

Clique em `Create Web Service`.

Quando terminar, abra a URL `.onrender.com` gerada pelo Render.
