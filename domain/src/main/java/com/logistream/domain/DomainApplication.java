package com.logistream.domain;

import java.util.TimeZone;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class DomainApplication {

    static {
        // The Postgres JDBC driver puts the JVM's default zone id in the
        // connection startup packet. On this Windows host that id is the legacy
        // alias "Asia/Calcutta", and postgres:16's tzdata only carries
        // "Asia/Kolkata" -- so every connection died with
        //   FATAL: invalid value for parameter "TimeZone": "Asia/Calcutta"
        // before a single query ran.
        //
        // Pinning the service to UTC fixes it without hardcoding anyone's
        // region: all timestamps are timestamptz in the database, the service
        // never formats local time, and it takes the host locale out of the
        // demo entirely. Log timestamps are therefore UTC.
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
    }

    public static void main(String[] args) {
        SpringApplication.run(DomainApplication.class, args);
    }
}
