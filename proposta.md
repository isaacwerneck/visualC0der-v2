Este é um guia conceitual e técnico para o desenvolvimento de um sintetizador
visual interativo via web (estilo TouchDesigner). O documento está estruturado
do início ao fim, propondo a arquitetura técnica, os módulos de análise de
áudio, as formas, os efeitos e como conectar tudo de forma dinâmica.

Blueprint do Projeto: Web Audio-Reactive Visualizer (WARV)

Este projeto consiste em uma plataforma web capaz de gerar gráficos em tempo
real utilizando WebGL, com parâmetros controlados dinamicamente pelos dados
extraídos de uma faixa de áudio (frequências, amplitude e BPM).

1. Arquitetura Técnica Sugerida

Para alcançar boa performance em navegadores, sugere-se a seguinte pilha de
tecnologias:

  - Motor de Renderização: Three.js (para 3D e pós-processamento conveniente) ou
    PixiJS (se preferir manter estritamente em 2D). Para controle absoluto de
    efeitos de fragmentação e pós-processamento, o uso de GLSL Shaders
    customizados é altamente recomendado.
  - Análise de Áudio: Web Audio API (nativo do navegador).
  - Interface Gráfica (UI): React ou Svelte para a estrutura da página,
    integrada com uma biblioteca de nós (como React Flow) ou um painel de
    parâmetros direto (estilo lil-gui ou Tweakpane).

2. O Motor de Áudio (Audio Analyzer)

Antes de gerar os visuais, é necessário decompor a música em dados utilizáveis.
O módulo de áudio deve expor as seguintes variáveis em tempo real para os
efeitos:

A. Divisão de Frequências (FFT)

Usando o AnalyserNode do Web Audio API, o espectro é dividido em três bandas
principais:

1.  Grave (Bass / Kick): 20Hz - 150Hz (Ideal para pulsos de escala, flashes e
    tremores).
2.  Médios (Mids / Vocal / Snare): 250Hz - 2000Hz (Ideal para deformações
    geométricas, rotações e ruído).
3.  Agudos (Highs / Cymbals): 4000Hz - 20000Hz (Ideal para partículas finas,
    brilho e distorções rápidas).

B. Mapeamento de BPM (Batidas por Minuto)

  - Detecção: Pode ser manual (um botão "Tap Tempo"), vinda de metadados do
    arquivo, ou estimada via algoritmo de detecção de picos (Peak Detection).
  - Variáveis exportadas:
      - beatTrigger: Um sinal booleano (trigger) enviado a cada batida.
      - beatProgress: Um valor de 0.0 a 1.0 que representa o progresso entre uma
        batida e a próxima (útil para interpolações suaves).
      - bpmStep: Um contador que incrementa a cada batida (0, 1, 2, 3...) para
        criar alternâncias de padrões.

C. Parâmetros de Controle (Moduladores)

  - Volume Geral (RMS/Amplitude): Volume médio do sinal para controle de
    intensidade geral.
  - Smoothing (Suavização): Um fator de interpolação linear (Lerp) de 0 a 1 para
    evitar que os visuais fiquem excessivamente ruidosos ou tremidos (por
    exemplo, visualValue = visualValue * (1 - smoothing) + targetValue *
    smoothing).

3. Geradores (As Formas Base)

Estes são os elementos visuais primários inseridos na tela antes da aplicação
dos efeitos.

Formas 2D

1.  Círculo / Anel: Parâmetros de raio, espessura da linha e quantidade de
    segmentos.
2.  Polígonos Regulares: Triângulo, quadrado, hexágono (com controle de número
    de lados).
3.  Grade de Linhas: Linhas horizontais/verticais que podem se curvar ou vibrar.
4.  Formas de Onda (Osciloscópio): Desenho direto do buffer de áudio do domínio
    do tempo na tela.

Formas 3D

1.  Cubo / Caixa: Parâmetros de largura, altura e profundidade.
2.  Esfera: Parâmetros de raio e detalhamento de polígonos.
3.  Toro (Donut): Parâmetros de raio maior, menor e rotação tubular.
4.  Malha de Terreno (Plane Mesh): Um plano subdividido onde a altura de cada
    vértice responde a uma frequência do áudio.

Sistema de Partículas

  - Emissor: Ponto central de onde nascem as partículas.
  - Propriedades: Quantidade, tamanho, tempo de vida útil (lifetime) e
    velocidade inicial.
  - Campos de Força (Noise Fields): Direcionamento das partículas usando Ruído
    de Perlin ou Simplex, cuja velocidade do fluxo é alterada pelo BPM ou
    agudos.

4. Biblioteca de Efeitos (Pós-Processamento e Shaders)

Aqui estão os efeitos para aplicação em camadas (layers) ou como um grafo de
nós. Cada efeito deve expor parâmetros que podem ser controlados manualmente ou
vinculados às variáveis de áudio.

Grupo A: Distorções Espaciais e Geometria

1. Kaleidoscope (Caleidoscópio)

  - Descrição: Divide a tela em fatias espelhadas em torno de um ponto central.
  - Parâmetros Personalizáveis:
      - Segments (Quantidade de divisões: 2 a 24).
      - Angle (Rotação do espelhamento).
      - Center X / Y (Ponto de origem do efeito).

2. Wave Displacement (Distorção por Onda)

  - Descrição: Ondas de seno/cosseno que distorcem as coordenadas de tela da
    imagem.
  - Parâmetros Personalizáveis:
      - Amplitude (Força da distorção).
      - Frequency (Frequência das ondas, gerando mais ou menos ondulações).
      - Speed (Velocidade com que as ondas se movem).

3. Simplex / Perlin Noise Warp

  - Descrição: Distorção orgânica de pixels baseada em algoritmos de ruído
    matemático.
  - Parâmetros Personalizáveis:
      - Noise Scale (Tamanho do padrão do ruído).
      - Noise Strength (Intensidade do desvio dos pixels).
      - Evolution Speed (A velocidade com que o ruído muda de forma ao longo do
        tempo).

Grupo B: Cor e Canal de Imagem

4. Chromatic Aberration (Aberração Cromática)

  - Descrição: Separação física dos canais Vermelho, Verde e Azul (RGB), comum
    em lentes reais.
  - Parâmetros Personalizáveis:
      - Offset Amount (Distância de separação entre as cores).
      - Angle (Direção para onde os canais se espalham).
      - Radial Aberration (Ativa a separação apenas nas bordas da tela).

5. Color Palette Mapper (Mapeador de Paleta)

  - Descrição: Converte a imagem em tons de cinza e a remapeia para um gradiente
    de cores personalizado pelo usuário.
  - Parâmetros Personalizáveis:
      - Color 1, 2, 3, 4 (Cores que compõem o gradiente).
      - Cycle Speed (Velocidade com que as cores rotacionam ao longo do
        gradiente).

6. Hue Shift / Saturation (Rotação de Matiz)

  - Descrição: Altera a tonalidade geral das cores de forma uniforme.
  - Parâmetros Personalizáveis:
      - Hue Offset (De 0 a 360 graus).
      - Saturation (Nível de intensidade da cor, do preto e branco ao super
        saturado).

Grupo C: Feedback e Tempo

7. Frame Feedback (Rastro / Trails)

  - Descrição: Mistura o frame atual com o frame anterior na GPU, gerando
    rastros de movimento.
  - Parâmetros Personalizáveis:
      - Decay (Tempo de persistência do rastro, de 0.0 a 1.0).
      - Feedback Scale (Zoom aplicado ao frame anterior, criando um efeito de
        túnel infinito se maior que 1.0).
      - Feedback Rotation (Giro aplicado ao frame anterior, criando espirais).

8. Glitch & RGB Split

  - Descrição: Cortes horizontais e distorções estáticas aleatórias que simulam
    sinal de TV analógica instável.
  - Parâmetros Personalizáveis:
      - Glitch Frequency (Probabilidade de ocorrer o glitch).
      - Glitch Intensity (O quão longe as fatias da imagem se movem).

Grupo D: Estilização

9. Pixelate (Pixelização)

  - Descrição: Reduz a resolução aparente da imagem dividindo-a em blocos de
    cores sólidas.
  - Parâmetros Personalizáveis:
      - Pixel Size (Tamanho dos blocos de pixels).
      - Aspect Ratio Lock (Mantém os blocos quadrados independente do formato da
        tela).

10. Bloom & Glow (Brilho Espectral)

  - Descrição: Isola as partes mais claras da tela, borra essas áreas e as soma
    de volta sobre a imagem original, dando um aspecto de luz neon.
  - Parâmetros Personalizáveis:
      - Threshold (O limite de brilho necessário para um pixel começar a
        brilhar).
      - Glow Radius (O tamanho do desfoque do brilho).
      - Glow Intensity (A força do brilho emitido).

5. Matriz de Modulação (O Coração da Interatividade)

Para permitir uma experiência personalizável, o sistema deve fornecer um
mecanismo onde o usuário seleciona [Fonte de Dados] \rightarrow
[Destino/Parâmetro].

Exemplo Prático de Mapeamento:

1.  Bass (Grave) \rightarrow Controla Torus Scale (Escala da forma 3D) com ganho
    de 2.0.
2.  Highs (Agudo) \rightarrow Controla Chromatic Aberration Offset (Intensidade
    da aberração cromática) com ganho de 0.5.
3.  BPM Beat (Gatilho) \rightarrow Inverte a direção do efeito de Feedback
    Rotation ou altera a cor do gradiente.
4.  BPM Progress (0-1) \rightarrow Controla a rotação suave do Caleidoscópio.

Interface de Configuração por Efeito (Sugestão de JSON de Estado):

{
  "layerId": "shape_torus_01",
  "type": "TorusGeometry",
  "parameters": {
    "radius": {
      "baseValue": 5.0,
      "modulator": "audio_bass",
      "modMultiplier": 1.5,
      "smoothing": 0.8
    },
    "rotationSpeed": {
      "baseValue": 0.1,
      "modulator": "bpm_progress",
      "modMultiplier": 1.0,
      "smoothing": 0.1
    }
  }
}

6. Fluxo de Execução Recomendado (Pipeline de Renderização)

Para obter um resultado visualmente integrado, organize o fluxo do sistema na
seguinte ordem lógica a cada quadro renderizado (Render Loop):

[Música / Microfone] 
       │
       ▼
[Web Audio API (AnalyserNode)] ──(Extrai Bass, Mids, Highs, BPM)
       │
       ▼
[Matriz de Modulação] ───────────(Atualiza os parâmetros com base no áudio)
       │
       ▼
[Render Scene] ──────────────────(Desenha formas 2D/3D no WebGL Render Target)
       │
       ▼
[Passes de Pós-Processamento] ───(Aplica Feedback ──> Caleidoscópio ──> Glitch ──> Bloom)
       │
       ▼
[Tela Final (Canvas)]

7. Ideias Adicionais para Destacar o Projeto

  - Presets de Vídeo: Disponibilize templates prontos (ex: "Cyberpunk", "Vintage
    VHS", "Minimal Tech") para que o usuário não precise configurar tudo do zero
    no primeiro contato.
  - Gravação Integrada (Export): Utilize a API MediaRecorder para permitir que o
    usuário grave a tela em formato de arquivo .webm ou .mp4 diretamente do
    navegador, facilitando a postagem em redes sociais.
  - Modo Performance: Opção de desativar efeitos mais pesados (como Bloom com
    muitos passos) para garantir taxas estáveis de 60 FPS em dispositivos móveis
    ou computadores mais simples.
