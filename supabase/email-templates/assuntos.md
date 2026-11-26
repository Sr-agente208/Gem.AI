# Assuntos personalizados (Supabase → Authentication → Email Templates)

Cole **um assunto por campo**, em português, com a marca Gem.AI:

| Campo no painel | Assunto |
| --- | --- |
| Confirm signup | `Gem.AI · Confirme seu e-mail` |
| Invite user | `Gem.AI · Você foi convidado` |
| Magic Link | `Gem.AI · Seu link de acesso` |
| Reset Password | `Gem.AI · Redefinir sua senha` |
| Change Email Address | `Gem.AI · Confirme o novo e-mail` |
| Password Changed Notification | `Gem.AI · Sua senha foi alterada` |
| Email Changed Notification | `Gem.AI · Seu e-mail foi alterado` |

Os corpos HTML estão nos arquivos deste diretório. Variáveis GoTrue aceitas:
`{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .NewEmail }}`, `{{ .OldEmail }}`,
`{{ .Token }}`, `{{ .Data.full_name }}`, `{{ .SiteURL }}`, `{{ .RedirectTo }}`.

> O conector do Supabase **não expõe** a escrita dos templates (só leitura via
> `get_auth_config`), então estes arquivos precisam ser colados no painel uma vez.
> O restante da config (Site URL, redirects, auto-confirm) já foi aplicado por API.
