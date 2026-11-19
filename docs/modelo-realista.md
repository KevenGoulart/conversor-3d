# Modelo realista do personagem

O app carrega `public/models/personagem.glb`. Nada é exibido até o modelo terminar de carregar;
se o arquivo não existir (ou der erro ao abrir), aparece um aviso com o erro no lugar do personagem.

O que o app faz com o modelo:

- Normaliza a altura para 1,80 m e coloca os pés no chão.
- Transforma as **shape keys** do corpo em sliders (aba Corpo; a aba Rosto foi retirada).
- Mostra os objetos `cabelo_*`, `baixo_*` e `sapato_*` como opções e pinta com as cores escolhidas.
- Toca a animação `idle` (ou a primeira que houver).
- Veste a roupa da foto: por padrão na camiseta pronta (`cima_camiseta`), pintada com a cor da foto e com a
  estampa desenhada no painel da frente ou das costas; no molde "Silhueta da foto", monta a peça a partir do
  contorno e a prende ao esqueleto e aos morphs do corpo.
- Mede ombros, gola, peito e ângulo dos braços a partir dos ossos, para encaixar a roupa da foto.

## Modelo padrão
O modelo padrão é o "Base Female - Game Ready - Rigged - Low Poly" de arte_art (CC BY 4.0,
https://skfb.ly/pJYJQ; o crédito aparece no canto da tela, como a licença exige). O arquivo baixado do
Sketchfab fica em `fonte/base-female/base-female.glb` e o `.glb` do app sai de:

```sh
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --python tools/gerar-base-female.py -- fonte/base-female/base-female.glb public/models/personagem.glb
```

O script zera a pose e a rotação extra que vêm do Sketchfab (o corpo vinha deitado), renomeia os ossos para o
padrão do app (`pelvis`, `spine_01`, `upperarm_l`…) e as malhas para a convenção abaixo, separa sobrancelha e
cílios, divide a roupa íntima em `intima_cima` e `intima_baixo` (o app esconde cada uma quando há roupa por
cima), junta as costuras e subdivide o corpo uma vez, tira a cor média da pele e suaviza os traços escuros da
pintura. O resto (pose A, shape keys de peso/músculo/quadril, camiseta, calça e tênis feitos do corpo, animação
`idle`) vem das funções de `tools/gerar-quaternius.py`; a camiseta ganha uma gola redonda e o tênis é
retirado (a personagem fica descalça e a aba Sapatos some quando o modelo não tem calçado).

Outras versões guardadas: MakeHuman realista em `public/models/personagem-anterior.glb` (`tools/gerar-personagem.py`;
`--estilizado` dá o visual semi-estilizado) e Quaternius em `public/models/personagem-quaternius.glb`.

## Gerar com o MakeHuman (realista)

Com o Blender e a extensão MPFB instalados, um comando gera o arquivo inteiro:

```sh
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --python tools/gerar-personagem.py -- public/models/personagem.glb
```

Acrescente `--feminino` no final para uma base feminina (o slider vira "Masculino") e `--branca`
para fixar a etnia em caucasiana (sem ela, é uma mistura das três). O modelo padrão do app é gerado
com `--feminino --branca --estilizado`; o masculino anterior está em `public/models/personagem-masculino.glb`.
O script cria corpo, esqueleto, shape keys (peso, músculo, idade, gênero e 5 do rosto),
olhos, sobrancelhas, 6 cabelos, saia, legging, a camiseta `cima_camiseta` e a animação `idle`. Também cria a shape key
`piscar` (pálpebras giradas em volta de cada olho até fecharem) e, com o pacote de assets
instalado, usa a textura de pele do MakeHuman dividida pela cor mediana (sobra só a variação
de lábios, bochechas e unhas, e o app continua escolhendo o tom). Para mudar a base
(proporções, etnia, cor de pele padrão), edite o dicionário `BASE` no começo do script.

O corpo sai subdividido uma vez (Catmull-Clark, com as shape keys recriadas na malha subdividida;
`BODY_SUBDIV` no script) e as texturas de pele e fios mantêm 2048 px (`MAX_TEXTURE_DETAIL`). As texturas
de cabelo passam por uma limpeza do alfa (riscos finos removidos, borda estendida 3 px para fechar as
frestas entre as faixas). As shape keys são exportadas sem normais, para o arquivo não passar de ~28 MB.
No app, a pele ganha um microrrelevo gerado em código (`src/lib/skinDetail.ts`) e os fios usam
alpha-to-coverage para a borda sair suave.

O resto deste documento explica a convenção, para quem quiser montar ou ajustar o modelo à mão.

## Modelo estilizado (Quaternius)

`tools/gerar-quaternius.py` gera `public/models/personagem.glb` a partir do pacote gratuito
"Universal Base Characters" do Quaternius (CC0, https://quaternius.itch.io/universal-base-characters):

```sh
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --python tools/gerar-quaternius.py -- "<pasta Universal Base Characters[Standard]>" public/models/personagem.glb
```

O script religa os cabelos ao esqueleto do corpo,
baixa os braços da pose T para uma pose A, renomeia para a convenção abaixo, tira a cor média da pele e cria
shape keys de peso, músculo e quadril por deformação (o pacote não traz nenhuma). A camiseta pronta
(`cima_camiseta`) é feita do próprio corpo: as faces do tronco e do começo dos braços são copiadas com os
pesos do esqueleto e as shape keys, afastadas ~1,2 cm da pele, suavizadas e cortadas por planos retos na
barra (acima da virilha) e nas mangas; o UV é refeito em dois painéis (frente e costas). A calça
(`baixo_calca`) sai pelo mesmo método, e o tênis (`sapato_tenis`) é o casco convexo de cada pé, cortado no
tornozelo, suavizado e com a sola reta (pesos do esqueleto copiados do corpo). O rosto feminino é uma
deformação fixa (mandíbula, queixo, arco das sobrancelhas e pescoço) e a sobrancelha é a `Eyebrows_Female`
do pacote; as texturas de cabelo são convertidas para cinza, para o app tingir com a cor escolhida.

## Camiseta pronta

A camiseta é a parte de cima do `male_casualsuit04` do pacote de assets (CC0). O gerador apaga a calça
(a metade de baixo do atlas UV), exporta só a oclusão como textura (dobras e axilas em cinza) e grava nos
extras do objeto o retângulo de cada painel no atlas, em coordenadas de imagem (0–1, y para baixo):
`uv_frente`, `uv_costas` e `uv_mangas`. O app pinta a textura com a cor predominante da foto, recorta a
estampa do tronco da foto (o que foge da cor do tecido) e a estica até o painel, multiplicando a oclusão
por cima. A camiseta também é empurrada para fora das peças de baixo, para o cós não atravessá-la.

## Convenção de nomes

| No Blender                         | No app                                             |
| ---------------------------------- | -------------------------------------------------- |
| objeto `corpo`                     | corpo (recebe a cor da pele)                       |
| objeto `cabelo_curto`, `cabelo_…`  | opções da aba Cabelo                               |
| objeto `baixo_calca`, `baixo_…`    | opções de Parte de baixo                           |
| objeto `sapato_tenis`, `sapato_…`  | opções de Sapatos                                  |
| objeto `cima_camiseta`             | camiseta pronta, pintada e estampada com a foto     |
| objeto `sobrancelha…`              | pinta com a cor do cabelo                          |
| objeto `iris…`                     | pinta com a cor dos olhos (só a íris)              |
| shape key `peso_mais` + `peso_menos` | um slider "Peso" de −1 a +1                      |
| shape key `musculo`                | um slider "Musculo" de 0 a 1                       |
| shape key `rosto_queixo`           | slider "Queixo" na aba Rosto                       |
| shape key `piscar`                 | piscar automático (não vira slider)                |
| ação `idle`                        | animação de parado                                 |

Shape keys com `$` no nome (as internas do MPFB) e `Basis` são ignoradas.

O app pinta os materiais multiplicando a cor escolhida. Para a cor ficar fiel, use materiais
simples (sem textura ou com textura clara) no corpo, no cabelo e nas roupas.

## Passo a passo com Blender + MPFB

> Testado com um modelo gerado por script, que tinha os mesmos nomes de ossos, shape keys e objetos.
> O fluxo do MPFB abaixo é o recomendado, mas os nomes dos menus podem variar entre versões.

1. **Instale** o Blender (4.2 ou mais novo) e o MPFB:
   *Edit → Preferences → Get Extensions*, procure "MPFB" e instale.
2. **Crie o humano**: na barra lateral (tecla `N`), aba *MPFB → New human*. Ajuste os sliders do
   modelo base (gênero, idade, proporções) até ficar com o corpo "médio" que você quer.
3. **Esqueleto**: *MPFB → Rigging → Add standard rig* e escolha **Game engine**
   (ossos `upperarm_l`, `lowerarm_l`, `neck_01`…; o app também reconhece os nomes do rig padrão e do Mixamo).
   Deixe na pose A que vem por padrão.
4. **Fixe a forma base**: selecione o corpo, vá em *Object Data → Shape Keys*, abra o menu `⌄` e use
   **Apply All Shape Keys**. Assim a forma base vira o "Basis".
5. **Crie as variações** (uma por vez):
   - No MPFB, mexa em **um** slider (ex.: *Weight* no máximo).
   - Em *Shape Keys → ⌄ → New Shape from Mix*, renomeie para `peso_mais`.
   - Volte o slider do MPFB ao valor original (ou apague a shape key que o MPFB criou).
   - Repita para `peso_menos`, `musculo_mais`/`musculo_menos`, `ombros`, `quadril`, `busto`, `barriga`
     e, para o rosto, `rosto_queixo`, `rosto_bochechas`, `rosto_nariz`…
   - Também dá para esculpir uma shape key à mão no modo *Sculpt* com ela selecionada.
6. **Remova os helpers** do MPFB (geometria auxiliar escondida pelo modificador *Mask*):
   apague os vértices do grupo de helpers no modo de edição e remova o modificador *Mask*.
   Não use "Apply Modifiers" na exportação, porque isso descarta as shape keys.
7. **Cabelo e roupas**: *MPFB → Apply assets*. Adicione quantos cabelos, calças e sapatos quiser e
   renomeie os objetos seguindo a tabela (`cabelo_longo`, `baixo_saia`, `sapato_bota`…).
   Renomeie o corpo para `corpo`. Não precisa esconder nada: o app mostra só o escolhido.
8. **Animação de parado (opcional)**: exporte o corpo em FBX, envie ao Mixamo, escolha uma animação
   "Idle", baixe *Without Skin* e transfira para o rig no Blender (ex.: addon Rokoko Retargeting).
   Renomeie a ação para `idle`.
9. **Exporte**: *File → Export → glTF 2.0*, formato **.glb**, com:
   - *Include*: tudo (não marque "Visible Objects"/"Selected Objects").
   - *Mesh*: UVs e Normals; **Apply Modifiers desligado**.
   - *Animation*: **Shape Keys**, **Skinning** e **Animation** ligados.

   Salve como `public/models/personagem.glb` e recarregue a página.

## Se algo não encaixar

- **Roupa da foto torta ou no lugar errado**: o app não achou os ossos do braço e do pescoço e usou as
  medidas padrão do corpo. Confira os nomes dos ossos (passo 3).
- **Slider não aparece**: confira se a shape key está no objeto `corpo` e se a opção *Shape Keys* estava
  marcada na exportação.
- **Cabelo ou roupa não acompanham o peso**: o app copia os morphs do corpo para os acessórios que
  não têm shape keys próprias. Se o acessório tiver shape keys com outros nomes, ele mantém as dele.
