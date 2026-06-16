# visualC0der-v2

## resumo

Aplicação Web JS com o proposito de criar visualizers reagentes a música, feedback visual totalmente personalizado.
Tipo um Touch Designer mais simples.

## coisas para adicionar

- play e pause mais bonitos pra deixar tocando a "cena" inteira ou não
    - do lado do botão, uma barrinha para volume e outra para mexer no tempo da música
    - garantir de que mesmo pausado, não vai tocar nenhum som, mesmo se eu escolher outra música. ele vai só tocar oq eu coloquei qnd eu apertar o play
    - vai aparecer o nomezinho do arquivo junto dessas paradas que eu pedi a cima tbm
    
- gostaria que além do modo microfone e inserir audio, tivesse a versão Band:
    - você vai colocar vários arquivos separados, cada um seria uma parte da música tipo: som 1 = bateria da musica, som 2 = guitarra, som 3 = baixo etc
    - cada arquivo terá uma forma geometrica respectiva a esse som (arquivo), que vai reagir de maneira independente mas sincronizada com as outras
    - por exemplo, fiz uma musica com 3 instrumentos, ai vou colocar cada audio deles separados e clicar em play, vai começar a tocar tudo junto como se fosse a musica junta.
        - para a bateria por exemplo será um quadrado que vai reagir distorcendo a cada porrada no kick, achatando a cada batida no hihat e expandindo a cada snare
        - para a guitarra, a cada nota será uma cor diferente em um circulo por exemplo, de acordo com o volume esse circulo distorce
        - para o baixo pode distorcer um triangulo por exemplo, ai ele vai se espelhando e movimentando de acordo com a intensidade e velocidade do baixo
        
- gostaria de implementar mais personalização para todos os 3 modos: 
    - você conseguirá escolher as formas geometricas, aonde quer colocar, ao o que ela vai reagir (modelo clica e arrasta em tudo pra ficar simples, com um menu de seleção)
    - você conseguirá aplicar distorções e diversos efeitos (cada um reage de uma forma diferente) - vai ser no mesmo modelo de clica e arrasta, menu de seleção de efeitos

