# FunASR 专有名词词表

`active.txt` 是产品默认读取的词表。文件使用 UTF-8，每行放一个希望 FunASR 优先识别的词；空行和以 `#` 开头的注释会被忽略。

切换客户行业时：

1. 复制 `active.txt` 为新文件，例如 `furniture.txt`。
2. 替换其中的专有名词，不要放客户私密信息。
3. 在本机 `.env` 中设置 `FUNASR_HOTWORD_FILE=config/hotwords/furniture.txt`，重启服务。

路径可以是相对应用目录的路径，也可以是绝对路径。英文多词品牌建议使用实际口语中常见的连写形式，因为空格会把一行拆成多个 hotword。
