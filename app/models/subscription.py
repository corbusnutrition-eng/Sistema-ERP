from sqlalchemy import Column, Date, Enum, ForeignKey, Integer
from sqlalchemy.orm import relationship

from app.db.base import Base


class Subscription(Base):
    __tablename__ = "subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False, index=True)
    service_id = Column(
        Integer,
        ForeignKey("iptv_services.id"),
        nullable=False,
        index=True,
    )
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=False)
    status = Column(
        Enum("active", "expired", "suspended", name="subscription_status_enum"),
        nullable=False,
        default="active",
    )

    client = relationship("Client", back_populates="subscriptions")
    service = relationship("IPTVService", back_populates="subscriptions")
