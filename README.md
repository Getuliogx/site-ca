# site-ca - StreamElements Watchlist

## Proteção adicionada

O servidor agora bloqueia o comando `/add` usando:

- `COMMAND_SECRET`
- `ALLOWED_CHANNELS`
- `ALLOWED_USERS`
- `ADD_COOLDOWN_MS`

## Variáveis no Render

Mantenha as que já existem e adicione estas:

```txt
ALLOWED_CHANNELS=carolinaporto
ALLOWED_USERS=carolinaporto,mod1,mod2
ADD_COOLDOWN_MS=3000
```

Troque `mod1,mod2` pelos nicks reais dos mods.

Também aceita estes nomes alternativos se preferir:

```txt
ALLOWED_MODS=mod1,mod2
ALLOWED_STREAMERS=carolinaporto
```

## Comando no StreamElements

Use passando canal e usuário:

```txt
$(urlfetch https://site-ca.onrender.com/add?token=carolina-add-watchlist&channel=$(channel)&user=$(user)&q=$(queryescape $(1:)))
```

Se alguém copiar o comando para outro canal, o servidor bloqueia com:

```txt
Canal não autorizado.
```

Se o usuário não estiver na lista do Render, bloqueia com:

```txt
Usuário não autorizado.
```

## Teste de permissões

No navegador:

```txt
https://site-ca.onrender.com/permissions?token=carolina-add-watchlist
```

Ele mostra os canais e usuários carregados do Render, sem mostrar senha do banco.
