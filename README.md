# site-ca - StreamElements Watchlist

## Correção da ordem (1.4.1)

Novos itens agora são gravados com `display_order = 0`.
A lógica antiga usava `-Date.now()`, que ultrapassava o limite de um `INT` do MySQL e acabava virando `-2147483648`.

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

## Formatos aceitos com ano

Agora o comando aceita ano para diferenciar nomes repetidos:

```txt
!add filme a mumia 1999
!add filme A Múmia (1999)
!add serie perdidos no espaço 2018 T1
!add serie perdidos no espaço T1 2018
!add anime dragon ball z 1989 T1
!add desenho ben 10 2005 T1
```

Também mantém o formato antigo para temporada:

```txt
!add serie lost 1
```

Números que fazem parte do nome continuam funcionando:

```txt
!add filme Distrito 9 2009
!add filme 1917 2019
```

## Teste de permissões

No navegador:

```txt
https://site-ca.onrender.com/permissions?token=carolina-add-watchlist
```

Ele mostra os canais e usuários carregados do Render, sem mostrar senha do banco.
