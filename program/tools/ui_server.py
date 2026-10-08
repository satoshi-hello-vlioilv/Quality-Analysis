"""画面だけを確かめるための開発用サーバー（窓 desktop/ の代わり。利用者の起動の道ではない）。

試験用の品質データ（tests/lotlist_fixture.py の 1500 行）を作業フォルダに作って参照先にし、アプリ（create_app）を
標準の http.server で配る。program/tools/ui-check.mjs・ui-variants.mjs が撮影と測定に使う（ui-harness.mjs が起こす）。
窓だけが答える /__desktop/* は、撮影の台本（ui-harness.mjs）が Playwright で作り物の答えを返す。

    python -u tools/ui_server.py [ポート]

待ち受けを始めたら 1 行出す（台本はそれを待つ）。マスタ・手元の写し・画面の設定の控えは作業フォルダに置くので、
リポジトリ（program/data など）を汚さない。
"""
import os
import sys
import tempfile
from pathlib import Path

PROGRAM = Path(__file__).resolve().parents[1]
WORK = Path(tempfile.mkdtemp(prefix="tpa-ui-"))
os.environ["TRANSFER_LOCAL_ROOT"] = str(WORK / "local")      # 画面の設定の控え・ログの置き場（create_app より前に決める）
sys.path.insert(0, str(PROGRAM))

from app import create_app  # noqa: E402
from app.repositories.master_store import MasterStore  # noqa: E402
from app.services.db_mirror import DbMirror  # noqa: E402
from app.web import serve_http  # noqa: E402
from tests import lotlist_fixture  # noqa: E402


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5077
    share = WORK / "share.sqlite3"
    lotlist_fixture.make(str(share), 1500)
    app = create_app({"MASTER_STORE": MasterStore(PROGRAM, local_root=WORK / "masters", settings={}),
                      "LOT_MIRROR": DbMirror("lot_list", share, WORK / "cache")})
    serve_http(app, port=port)


if __name__ == "__main__":
    main()
