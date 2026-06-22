from sqlalchemy.orm import declarative_base

Base = declarative_base()

from app.models import (  # noqa: E402,F401
    client,
    invoice,
    iptv_service,
    subscription,
    transaction,
)
