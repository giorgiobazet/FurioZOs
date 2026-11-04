# FurioZOs

Site oficial da **Atlética FurioZOs (A.U UERJ-ZO)**: uma loja online com cadastro de usuários, vitrine de produtos, carrinho e pagamento online.

🔗 **Ao vivo:** https://atletica-furiozos.web.app

## Funcionalidades

- Cadastro e login de usuários
- Carrossel de destaques e cards de produtos
- Carrinho de compras
- Pagamento online via PIX e cartão

## Tecnologias

- **Front-end:** HTML, CSS e JavaScript
- **Back-end/infra:** Firebase (Hosting, Firestore e Authentication)
- **Pagamentos:** Mercado Pago, integrado por meio de um Cloudflare Worker

## Estrutura

- `public/`: páginas e arquivos estáticos do site
- `worker/`: Cloudflare Worker responsável pela integração de pagamento
- `firestore.rules` e `firebase.json`: regras e configuração do Firebase

## Autor

Desenvolvido por [Giorgio Bazet](https://github.com/giorgiobazet), Diretor de Tecnologia da Atlética FurioZOs.
